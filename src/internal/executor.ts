import * as nt from "nekoton-wasm";
import { Address, FullContractState } from "everscale-inpage-provider";
import { Heap } from "heap-js";
import _ from "lodash";
import { EMPTY_STATE, GIVER_ADDRESS, GIVER_BOC, TEST_CODE_HASH, ZERO_ADDRESS } from "./constants";
import { BlockchainConfig } from "nekoton-wasm";
import { AccountFetcherCallback } from "../types";

const messageComparator = (a: nt.JsRawMessage, b: nt.JsRawMessage) => (a.lt || 0) - (b.lt || 0);

type ExecutorState = {
  accounts: { [id: string]: FullContractState };
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
  private state: ExecutorState;
  private snapshots: { [id: string]: ExecutorState } = {};
  private nonce = 0;
  private blockchainConfig: string | undefined;
  private globalId: number | undefined;
  private clock: nt.ClockWithOffset | undefined;

  constructor(
    private readonly transport: LockliftTransport,
    private readonly accountFetcherCallback?: AccountFetcherCallback,
  ) {
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

    transport.setExecutor(this);
  }

  async initialize() {
    const config = await this.transport.getBlockchainConfig();
    this.blockchainConfig = config.boc;
    this.globalId = Number(config.globalId);
  }

  setClock(clock: nt.ClockWithOffset) {
    if (this.clock !== undefined) throw new Error("Clock already set");
    this.clock = clock;
  }

  _setAccount(address: Address | string, boc: string) {
    this.state.accounts[address.toString()] = nt.parseFullAccountBoc(boc) as nt.FullContractState;
  }
  setAccount(address: Address | string, boc: string, type: "accountStuffBoc" | "fullAccountBoc") {
    this.state.accounts[address.toString()] = nt.parseFullAccountBoc(
      type === "accountStuffBoc" ? nt.makeFullAccountBoc(boc) : boc,
    ) as nt.FullContractState;
  }

  async getAccount(address: Address | string): Promise<FullContractState | undefined> {
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

  getAccounts(): { [id: string]: FullContractState } {
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

  // process all msgs in queue
  async processQueue() {
    while (this.state.messageQueue.size() > 0) {
      await this.processNextMsg();
    }
  }

  // process msg with lowest lt in queue
  async processNextMsg() {
    const message = this.state.messageQueue.pop() as nt.JsRawMessage;
    // everything is processed
    if (!message) return;
    const receiverAcc = await this.getAccount(message.dst as string);

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

  // push new message to queue
  enqueueMsg(message: nt.JsRawMessage) {
    this.state.messageQueue.push(message);
  }
}
