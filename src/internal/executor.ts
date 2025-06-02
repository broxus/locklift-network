import * as nt from "nekoton-wasm";
import { BlockchainConfig } from "nekoton-wasm";
import { Address, LT_COLLATOR } from "everscale-inpage-provider";
import { Heap } from "heap-js";
import _ from "lodash";
import { GIVER_ADDRESS, GIVER_BOC, ZERO_ADDRESS } from "./constants";
import { AccountFetcherCallback } from "../types";
import { TychoExecutor } from "@tychosdk/emulator";
import { beginCell, Cell, storeShardAccount } from "@ton/core";
import type { ExecutorEmulationResult } from "@ton/sandbox";
import { bocFromShardAccount, parseBlocks, shardAccountFromBoc } from "./utils";

const messageComparator = (a: nt.JsRawMessage, b: nt.JsRawMessage) => LT_COLLATOR.compare(a.lt || "0", b.lt || "0");
const emptyShardAccount = beginCell()
  .store(
    storeShardAccount({
      account: null,
      lastTransactionHash: 0n,
      lastTransactionLt: 0n,
    }),
  )
  .endCell()
  .toBoc()
  .toString("base64");
type ExecutorState = {
  // accounts: { [id: string]: nt.FullContractState };
  accounts: { [id: string]: string };
  // txId -> tx
  transactions: { [id: string]: nt.JsRawTransaction };
  // txId -> trace
  traces: { [id: string]: nt.EngineTraceInfo[] };
  // msgHash -> tx_id
  msgToTransaction: { [msgHash: string]: string };
  // address -> tx_ids
  addrToTransactions: { [addr: string]: string[] };
  messageQueue: Heap<nt.JsRawMessage>;
};

interface LockliftTransport {
  getBlockchainConfig(): Promise<BlockchainConfig>;
  setExecutor(executor: LockliftExecutor): void;
}

export class LockliftExecutor {
  private state: ExecutorState = {} as ExecutorState;
  private snapshots: { [id: string]: ExecutorState } = {};
  private nonce = 0;
  private blockchainConfig!: string;
  private globalId: number | undefined;
  private clock: nt.ClockWithOffset | undefined;
  private tychoExecutor!: TychoExecutor;
  blockchainLt = 1000n;

  constructor(
    private readonly transport: LockliftTransport,
    private readonly accountFetcherCallback?: AccountFetcherCallback,
  ) {
    this.createInitialBlockchainState();
    transport.setExecutor(this);
  }

  private createInitialBlockchainState() {
    this.state = {
      accounts: {},
      transactions: {},
      msgToTransaction: {},
      addrToTransactions: {},
      traces: {},
      messageQueue: new Heap<nt.JsRawMessage>(messageComparator),
    };
    // set this in order to pass standalone-client checks

    this.state.accounts[ZERO_ADDRESS.toString()] = bocFromShardAccount({
      account: null,
      lastTransactionHash: 0n,
      lastTransactionLt: 0n,
    });

    this.state.accounts[GIVER_ADDRESS] = bocFromShardAccount(shardAccountFromBoc(nt.makeFullAccountBoc(GIVER_BOC), 0n));
  }

  async initialize() {
    const config = await this.transport.getBlockchainConfig();
    const configBok = Cell.fromBase64(config.boc).asSlice().loadRef().toBoc().toString("base64");
    this.blockchainConfig = configBok;
    this.globalId = Number(config.globalId);
    this.tychoExecutor = await TychoExecutor.create();
  }

  setClock(clock: nt.ClockWithOffset) {
    if (this.clock !== undefined) throw new Error("Clock already set");
    this.clock = clock;
  }

  _setAccount1(address: Address | string, boc: string) {
    this.state.accounts[address.toString()] = boc;
  }

  setAccount(address: Address | string, boc: string, type: "accountStuffBoc" | "fullAccountBoc") {
    const fullContractState = nt.parseFullAccountBoc(
      type === "accountStuffBoc" ? nt.makeFullAccountBoc(boc) : boc,
    ) as nt.FullContractState;
    this.state.accounts[address.toString()] = bocFromShardAccount(shardAccountFromBoc(fullContractState.boc));
  }

  async _getAccount(address: Address | string): Promise<string | undefined> {
    return this.state.accounts[address.toString()];
    // ||
    // this.accountFetcherCallback?.(address instanceof Address ? address : new Address(address))
    //   .then(({ boc, type }) => {
    //     if (!boc) throw new Error("Account not found");
    //     this.setAccount(address, boc, type);
    //     return this.state.accounts[address.toString()];
    //   })
    //   .catch(e => {
    //     console.error(`Failed to fetch account ${address.toString()}: ${e.trace}`);
    //     return undefined;
    //   })
  }

  getAccounts(): Record<string, nt.FullContractState> {
    return Object.entries(this.state.accounts).reduce((acc, next) => {
      const [address, account] = next;
      const fullContractState = nt.parseShardAccountBoc(account);
      if (!fullContractState) {
        return acc;
      }
      acc[address] = fullContractState;
      return acc;
    }, {} as Record<string, nt.FullContractState>);
  }

  getTxTrace(txId: string): nt.EngineTraceInfo[] | undefined {
    return this.state.traces[txId];
  }

  private saveTransaction(tx: nt.JsRawTransaction, trace: nt.EngineTraceInfo[]) {
    this.state.transactions[tx.hash] = tx;
    this.state.msgToTransaction[tx.inMessage.hash] = tx.hash;
    this.state.addrToTransactions[tx.inMessage.dst as string] = [tx.hash].concat(
      this.state.addrToTransactions[tx.inMessage.dst as string] || [],
    );
    this.state.traces[tx.hash] = trace;
  }

  getDstTransaction(msgHash: string): nt.JsRawTransaction | undefined {
    return this.state.transactions[this.state.msgToTransaction[msgHash]];
  }

  getTransaction(id: string): nt.JsRawTransaction | undefined {
    return this.state.transactions[id];
  }

  getTransactions(address: Address | string, fromLt: string, count: number): nt.JsRawTransaction[] {
    const result: nt.JsRawTransaction[] = [];
    for (const txId of this.state.addrToTransactions[address.toString()] || []) {
      const rawTx = this.state.transactions[txId];
      if (Number(rawTx.lt) > Number(fromLt)) continue;
      result.push(rawTx);
      if (result.length >= count) return result;
    }
    return result;
  }

  saveSnapshot(): number {
    this.snapshots[this.nonce] = _.cloneDeep(this.state);
    // postincrement!
    return this.nonce++;
  }

  loadSnapshot(id: number) {
    if (this.snapshots[id] === undefined) {
      throw new Error(`Snapshot ${id} not found`);
    }
    this.state = this.snapshots[id];
  }

  clearSnapshots() {
    this.snapshots = {};
  }

  resetBlockchainState() {
    this.createInitialBlockchainState();
  }

  // process all msgs in queue
  async processQueue() {
    while (this.state.messageQueue.size() > 0) {
      await this.processNextMsg();
    }
  }

  // process msg with lowest lt in queue
  async processNextMsg() {
    const startTime = Date.now();

    const message = this.state.messageQueue.pop() as nt.JsRawMessage;
    // everything is processed
    if (!message) return;
    const receiverAcc = (await this._getAccount(message.dst as string)) || emptyShardAccount;

    const messageCell = Cell.fromBase64(message.boc);

    const now = Math.floor(this.clock!.nowMs / 1000);

    let res: ExecutorEmulationResult = await this.tychoExecutor.runTransaction({
      config: this.blockchainConfig,
      message: messageCell,
      lt: this.blockchainLt,
      shardAccount: receiverAcc,
      now,
      libs: null,
      debugEnabled: true,
      randomSeed: null,
      verbosity: "short",
      ignoreChksig: true,
    });

    if (!res.result.success) {
      console.log("Error in executor: ", res.result.error);
      return;
    }

    const decodedTx = nt.decodeRawTransaction(res.result.transaction);
    let trace: Array<nt.EngineTraceInfo> = [];
    if (decodedTx.description.aborted) {
      // run 1 more time with trace on
      res = await this.tychoExecutor.runTransaction({
        config: this.blockchainConfig,
        message: messageCell,
        lt: this.blockchainLt,
        shardAccount: receiverAcc,
        now,
        libs: null,
        debugEnabled: true,
        randomSeed: null,
        verbosity: "full_location_stack_verbose",
        ignoreChksig: true,
      });

      if (res.result.success && res.result.vmLog) {
        trace = parseBlocks(res.result.vmLog);
      }
    }

    if (res.logs || res.debugLogs) {
      console.log("Debug logs: ", res.debugLogs);
    }

    if (!res.result.success) {
      console.log("Error in executor: ", res.result.error);
      return;
    }
    this.blockchainLt += 1000n;
    if (res.result.shardAccount) {
      this._setAccount1(message.dst as string, res.result.shardAccount);

      this.saveTransaction(decodedTx, trace);
      decodedTx.outMessages.map((msg: nt.JsRawMessage) => {
        if (msg.msgType === "ExtOut") return; // event
        this.enqueueMsg(msg);
      });
    }
  }

  // push new message to queue
  enqueueMsg(message: nt.JsRawMessage) {
    this.state.messageQueue.push(message);
  }
}
