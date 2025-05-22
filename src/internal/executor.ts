import * as nt from "nekoton-wasm";
import { BlockchainConfig } from "nekoton-wasm";
import { Address, LT_COLLATOR } from "everscale-inpage-provider";
import { Heap } from "heap-js";
import _ from "lodash";
import { defaultConfig, EMPTY_STATE, GIVER_ADDRESS, GIVER_BOC, TEST_CODE_HASH, ZERO_ADDRESS } from "./constants";
import { AccountFetcherCallback } from "../types";
import { TychoExecutor } from "@tychosdk/emulator";
import {
  Account,
  beginCell,
  Cell,
  loadAccount,
  loadShardAccount,
  ShardAccount,
  storeAccount,
  storeShardAccount,
} from "@ton/core";
import type { ExecutorEmulationResult } from "@ton/sandbox";
import { shardAccountFromBoc, parseBlocks, fullContractStateFromShardAccount } from "./utils";

const messageComparator = (a: nt.JsRawMessage, b: nt.JsRawMessage) => LT_COLLATOR.compare(a.lt || "0", b.lt || "0");

type ExecutorState = {
  // accounts: { [id: string]: nt.FullContractState };
  accounts: { [id: string]: ShardAccount };
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
    // this.state.accounts[ZERO_ADDRESS.toString()] = nt.parseFullAccountBoc(
    //   nt.makeFullAccountBoc(GIVER_BOC),
    // ) as nt.FullContractState;
    // this.state.accounts[ZERO_ADDRESS.toString()].codeHash = TEST_CODE_HASH;
    // // manually add giver account
    // this.state.accounts[GIVER_ADDRESS] = nt.parseFullAccountBoc(
    //   nt.makeFullAccountBoc(GIVER_BOC),
    // ) as nt.FullContractState;
    this.state.accounts[ZERO_ADDRESS.toString()] = {
      account: null,
      lastTransactionHash: 0n,
      lastTransactionLt: 0n,
    };
    // this.state.accounts[ZERO_ADDRESS.toString()].codeHash = TEST_CODE_HASH;
    // manually add giver account
    this.state.accounts[GIVER_ADDRESS] = shardAccountFromBoc(nt.makeFullAccountBoc(GIVER_BOC), 0n);
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
    this.state.accounts[address.toString()] = shardAccountFromBoc(boc);
  }
  _setAccount1(address: Address | string, shardAccount: ShardAccount) {
    this.state.accounts[address.toString()] = shardAccount;
  }
  _removeAccount(address: Address | string) {
    delete this.state.accounts[address.toString()];
  }
  setAccount(address: Address | string, boc: string, type: "accountStuffBoc" | "fullAccountBoc") {
    const fullContractState = nt.parseFullAccountBoc(
      type === "accountStuffBoc" ? nt.makeFullAccountBoc(boc) : boc,
    ) as nt.FullContractState;
    this.state.accounts[address.toString()] = shardAccountFromBoc(fullContractState.boc);
  }

  async getAccount(address: Address | string): Promise<nt.FullContractState | undefined> {
    return this.state.accounts[address.toString()]?.account
      ? fullContractStateFromShardAccount(this.state.accounts[address.toString()])
      : undefined;
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

  async _getAccount(address: Address | string): Promise<ShardAccount | undefined> {
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
    const res = Object.entries(this.state.accounts).reduce((acc, next) => {
      const [address, account] = next;
      if (account.account === null) return acc;
      acc[address] = fullContractStateFromShardAccount(account);
      return acc;
    }, {} as Record<string, nt.FullContractState>);

    return res;
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
    debugger;
    const message = this.state.messageQueue.pop() as nt.JsRawMessage;
    // everything is processed
    if (!message) return;
    const receiverAcc = await this.getAccount(message.dst as string);
    const startTime = Date.now();
    let res: nt.TransactionExecutorExtendedOutput = nt.executeLocalExtended(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.blockchainConfig!,
      receiverAcc?.boc ? receiverAcc.boc : EMPTY_STATE,
      message.boc,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      Math.floor(this.clock!.nowMs / 1000),
      false,
      undefined,
      undefined,
      this.globalId,
      false,
    );
    this.totalExecuterExecutionTime += Date.now() - startTime;
    console.log("Executer execution time: " + this.totalExecuterExecutionTime);

    if ("account" in res && res.transaction.description.aborted) {
      // run 1 more time with trace on
      res = nt.executeLocalExtended(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.blockchainConfig!,
        receiverAcc?.boc ? receiverAcc.boc : EMPTY_STATE,
        message.boc,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        Math.floor(this.clock!.nowMs / 1000),
        false,
        undefined,
        undefined,
        this.globalId,
        true,
      );
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
    const receiverAcc = (await this._getAccount(message.dst as string)) || {
      account: null,
      lastTransactionHash: 0n,
      lastTransactionLt: 0n,
    };
    const messageCell = Cell.fromBase64(message.boc);

    // if (receiverAcc.account) {
    //   receiverAcc.account.storage.lastTransLt += 1n;
    // }
    const shardAccountBok = beginCell().store(storeShardAccount(receiverAcc)).endCell().toBoc().toString("base64");
    const now = Math.floor(this.clock!.nowMs / 1000);

    const startTime = Date.now();
    let res: ExecutorEmulationResult = await this.tychoExecutor.runTransaction({
      config: defaultConfig,
      message: messageCell,
      // lt: (receiverAcc?.account?.storage.lastTransLt || 0n) + 10n,
      lt: this.blockchainLt,
      shardAccount: shardAccountBok,
      now,
      libs: null,
      debugEnabled: true,
      randomSeed: null,
      verbosity: "short",
      ignoreChksig: true,
    });
    this.totalExecuterExecutionTime += Date.now() - startTime;
    console.log("Executer execution time: " + this.totalExecuterExecutionTime);

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
        lt: this.blockchainLt,
        shardAccount: beginCell().store(storeShardAccount(receiverAcc)).endCell().toBoc().toString("base64"),
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
      console.log("debugLogs: ", res.debugLogs);
    }

    if (!res.result.success) {
      console.log("Error in executor: ", res.result.error);
      return;
    }
    this.blockchainLt += 1000n;
    console.log("Executer execution time: " + this.totalExecuterExecutionTime);
    if (res.result.shardAccount) {
      const shardAccount = loadShardAccount(Cell.fromBase64(res.result.shardAccount).beginParse());
      if (shardAccount.account) {
        this._setAccount1(message.dst as string, shardAccount);
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
