import * as nt from "nekoton-wasm";
import { Address, FullContractState } from "everscale-inpage-provider";
import { Heap } from "heap-js";
import _ from "lodash";
import { EMPTY_STATE, GIVER_ADDRESS, GIVER_BOC, TEST_CODE_HASH, ZERO_ADDRESS } from "./constants";

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
  getBlockchainConfig(): string[];
  setExecutor(executor: LockliftExecutor): void;
}

export class LockliftExecutor {
  private state: ExecutorState;
  private snapshots: { [id: string]: ExecutorState } = {};
  private nonce = 0;
  private readonly blockchainConfig: string;
  private readonly globalId: number;
  private clock: nt.ClockWithOffset | undefined;

  constructor(private readonly transport: LockliftTransport) {
    const config = transport.getBlockchainConfig();
    this.blockchainConfig = config[0];
    this.globalId = Number(config[1]);
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

  setClock(clock: nt.ClockWithOffset) {
    if (this.clock !== undefined) throw new Error("Clock already set");
    this.clock = clock;
  }

  private setAccount(address: Address | string, boc: string) {
    this.state.accounts[address.toString()] = nt.parseFullAccountBoc(boc) as nt.FullContractState;
  }

  getAccount(address: Address | string): FullContractState | undefined {
    return this.state.accounts[address.toString()];
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
    // console.log('get dst tx');
    return this.state.transactions[this.state.msgToTransaction[msgHash]];
  }

  getTransaction(id: string): nt.JsRawTransaction | undefined {
    // console.log('get transaction');
    return this.state.transactions[id];
  }

  // TODO: optimize
  getTransactions(address: Address | string, fromLt: string, count: number): nt.JsRawTransaction[] {
    const rawTxs = (this.state.addrToTransactions[address.toString()] || []).map(id => this.state.transactions[id]);
    // return rawTxs;
    return rawTxs.filter(tx => Number(tx.lt) <= Number(fromLt)).slice(0, count);
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
  processQueue() {
    while (this.state.messageQueue.size() > 0) {
      this.processNextMsg();
    }
  }

  // process msg with lowest lt in queue
  processNextMsg() {
    const message = this.state.messageQueue.pop() as nt.JsRawMessage;
    // everything is processed
    if (!message) return;
    const receiverAcc = this.getAccount(message.dst as string);
    let res: nt.TransactionExecutorExtendedOutput = nt.executeLocalExtended(
      this.blockchainConfig,
      receiverAcc ? nt.makeFullAccountBoc(receiverAcc.boc) : EMPTY_STATE,
      message.boc,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      Math.floor(this.clock!.nowMs / 1000),
      false,
      undefined,
      this.globalId,
      false,
    );
    if ("account" in res && res.transaction.description.aborted) {
      // run 1 more time with trace on
      res = nt.executeLocalExtended(
        this.blockchainConfig,
        receiverAcc ? nt.makeFullAccountBoc(receiverAcc.boc) : EMPTY_STATE,
        message.boc,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        Math.floor(this.clock!.nowMs / 1000),
        false,
        undefined,
        this.globalId,
        true,
      );
    }
    if ("account" in res) {
      this.setAccount(message.dst as string, res.account);
      this.saveTransaction(res.transaction, res.trace);
      res.transaction.outMessages.map((msg: nt.JsRawMessage) => {
        if (msg.dst === undefined) return; // event
        this.enqueueMsg(msg);
      });
    }
  }

  // push new message to queue
  enqueueMsg(message: nt.JsRawMessage) {
    this.state.messageQueue.push(message);
  }
}
