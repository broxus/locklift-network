import * as nt from "nekoton-wasm";
import { Address, FullContractState, LT_COLLATOR } from "everscale-inpage-provider";
import { Heap } from "heap-js";
import _ from "lodash";
import { defaultConfig, EMPTY_STATE, GIVER_ADDRESS, GIVER_BOC, TEST_CODE_HASH, ZERO_ADDRESS } from "./constants";
import { BlockchainConfig } from "nekoton-wasm";
import { AccountFetcherCallback } from "../types";
import { TychoExecutor } from "@tychosdk/emulator";
import { Account, beginCell, Cell, loadAccount, loadShardAccount, storeAccount, storeShardAccount } from "@ton/core";
import type { ExecutorEmulationResult } from "@ton/sandbox";
import { parseBlocks } from "./utils";

const messageComparator = (a: nt.JsRawMessage, b: nt.JsRawMessage) => LT_COLLATOR.compare(a.lt || "0", b.lt || "0");
export interface FullContractStateCut {
  boc: string;
  balance?: string;
  isDeployed: boolean;
  codeHash?: string;
}
type ExecutorState = {
  accounts: { [id: string]: nt.FullContractState };
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
  totalExecuterExecutionTime = 0;

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
    this.state.accounts[ZERO_ADDRESS.toString()] = nt.parseFullAccountBoc(
      nt.makeFullAccountBoc(GIVER_BOC),
    ) as nt.FullContractState;
    this.state.accounts[ZERO_ADDRESS.toString()].codeHash = TEST_CODE_HASH;
    // manually add giver account
    this.state.accounts[GIVER_ADDRESS] = nt.parseFullAccountBoc(
      nt.makeFullAccountBoc(GIVER_BOC),
    ) as nt.FullContractState;
  }

  async initialize() {
    const config = await this.transport.getBlockchainConfig();
    this.blockchainConfig = config.boc;
    this.globalId = Number(config.globalId);
    this.tychoExecutor = await TychoExecutor.create();
  }

  setClock(clock: nt.ClockWithOffset) {
    if (this.clock !== undefined) throw new Error("Clock already set");
    this.clock = clock;
  }

  _setAccount(address: Address | string, boc: string) {
    this.state.accounts[address.toString()] = nt.parseFullAccountBoc(boc) as nt.FullContractState;
  }
  _setAccount1(address: Address | string, fullContractState: nt.FullContractState) {
    this.state.accounts[address.toString()] = fullContractState;
  }
  _removeAccount(address: Address | string) {
    delete this.state.accounts[address.toString()];
  }
  setAccount(address: Address | string, boc: string, type: "accountStuffBoc" | "fullAccountBoc") {
    this.state.accounts[address.toString()] = nt.parseFullAccountBoc(
      type === "accountStuffBoc" ? nt.makeFullAccountBoc(boc) : boc,
    ) as nt.FullContractState;
  }

  async getAccount(address: Address | string): Promise<nt.FullContractState | undefined> {
    return (
      this.state.accounts[address.toString()] ||
      this.accountFetcherCallback?.(address instanceof Address ? address : new Address(address))
        .then(({ boc, type }) => {
          if (!boc) throw new Error("Account not found");
          this.setAccount(address, boc, type);
          return this.state.accounts[address.toString()];
        })
        .catch(e => {
          console.error(`Failed to fetch account ${address.toString()}: ${e.trace}`);
          return undefined;
        })
    );
  }

  getAccounts(): { [id: string]: FullContractStateCut } {
    return this.state.accounts;
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

  // // process msg with lowest lt in queue
  async processNextMsg_old() {
    const message = this.state.messageQueue.pop() as nt.JsRawMessage;
    // everything is processed
    if (!message) return;
    const receiverAcc = await this.getAccount(message.dst as string);
    const startTime = Date.now();
    let res: nt.TransactionExecutorExtendedOutput = nt.executeLocalExtended(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.blockchainConfig!,
      receiverAcc ? nt.makeFullAccountBoc(receiverAcc.boc) : EMPTY_STATE,
      message.boc,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      Math.floor(this.clock!.nowMs / 1000),
      false,
      undefined,
      undefined,
      this.globalId,
      false,
    );

    if ("account" in res && res.transaction.description.aborted) {
      // run 1 more time with trace on
      res = nt.executeLocalExtended(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.blockchainConfig!,
        receiverAcc ? nt.makeFullAccountBoc(receiverAcc.boc) : EMPTY_STATE,
        message.boc,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        Math.floor(this.clock!.nowMs / 1000),
        false,
        undefined,
        undefined,
        this.globalId,
        true,
      );
      debugger;
    }

    if ("account" in res) {
      this._setAccount(message.dst as string, res.account);
      this.saveTransaction(res.transaction, res.trace);
      res.transaction.outMessages.map((msg: nt.JsRawMessage) => {
        if (msg.msgType === "ExtOut") return; // event
        this.enqueueMsg(msg);
      });
    }
  }

  // process msg with lowest lt in queue
  async processNextMsg() {
    const message = this.state.messageQueue.pop() as nt.JsRawMessage;
    // everything is processed
    if (!message) return;
    const receiverAcc = await this.getAccount(message.dst as string);
    const messageCell = Cell.fromBase64(message.boc);
    const acc = receiverAcc ? loadAccount(Cell.fromBase64(receiverAcc.boc).beginParse()) : null;
    if (acc) {
      acc.storage.lastTransLt += 1n;
    }

    const now = Math.floor(this.clock!.nowMs / 1000);
    const shardAcc = storeShardAccount({
      account: acc,
      lastTransactionHash: BigInt(Number("0x" + (receiverAcc?.lastTransactionId?.hash || "0"))),

      lastTransactionLt: receiverAcc ? BigInt(receiverAcc.lastTransactionId.lt) : 0n,
    });
    const startTime = Date.now();
    let res: ExecutorEmulationResult = await this.tychoExecutor.runTransaction({
      config: defaultConfig,
      message: messageCell,
      lt: (acc?.storage.lastTransLt || 0n) + 10n,
      shardAccount: beginCell().store(shardAcc).endCell().toBoc().toString("base64"),
      now,
      libs: null,
      debugEnabled: true,
      randomSeed: null,
      verbosity: "short",
      ignoreChksig: true,
    });
    this.totalExecuterExecutionTime += Date.now() - startTime;

    if (!res.result.success) {
      console.log("Error in executor: ", res.result.error);
      return;
    }
    const decodedTx = nt.decodeRawTransaction(res.result.transaction);
    let trace: Array<nt.EngineTraceInfo> = [];
    if (decodedTx.description.aborted) {
      // run 1 more time with trace on
      res = await this.tychoExecutor.runTransaction({
        config: defaultConfig,
        message: messageCell,
        lt: (acc?.storage.lastTransLt || 0n) + 10n,
        shardAccount: beginCell().store(shardAcc).endCell().toBoc().toString("base64"),
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
      debugger;
    }

    if (res.logs || res.debugLogs) {
      console.log("logs: ", res.logs);
      console.log("debugLogs: ", res.debugLogs);
    }

    if (!res.result.success) {
      console.log("Error in executor: ", res.result.error);
      return;
    }

    console.log("Executer execution time: " + this.totalExecuterExecutionTime);
    if (res.result.shardAccount) {
      const shardAccount = loadShardAccount(Cell.fromBase64(res.result.shardAccount).beginParse());
      if (shardAccount.account) {
        const b = beginCell();
        storeAccount(shardAccount.account as Account)(b);
        const accountBoc = b.endCell().toBoc().toString("base64");

        const fullContractState: nt.FullContractState = {
          balance: shardAccount.account?.storage?.balance.coins?.toString() || "0",
          genTimings: {
            // genLt: shardAccount.account?.storage.lastTransLt.toString() || "0",
            genLt: "0",
            genUtime: 0,
          },
          lastTransactionId: {
            lt: decodedTx.lt,

            hash: decodedTx.hash.toString(),
            isExact: false,
          },
          isDeployed: shardAccount.account?.storage.state.type === "active",
          codeHash:
            shardAccount.account?.storage.state.type === "active"
              ? shardAccount.account.storage.state.state.code?.hash().toString("hex")
              : undefined,
          boc: accountBoc,
        };

        this._setAccount1(message.dst as string, fullContractState);
      } else {
        this._removeAccount(message.dst as string);
      }

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
