import * as nt from "nekoton-wasm";
import {Address, FullContractState} from "everscale-inpage-provider";
import {Heap} from "heap-js";
import _ from "lodash";

const messageComparator = (a: nt.JsRawMessage, b: nt.JsRawMessage) => (a.lt || 0) - (b.lt || 0);

type ExecutorState = {
  accounts: { [id: string]: FullContractState },
  // tx_id -> tx
  transactions: { [id: string]: nt.JsRawTransaction },
  // msg_hash -> tx_id
  msgToTransaction: { [msg_hash: string]: string },
  // address -> tx_ids
  addrToTransactions: { [addr: string]: string[] },
  messageQueue: Heap<nt.JsRawMessage>
}

interface LockliftTransport {
  getBlockchainConfig(): string[];
  setExecutor(executor: LockliftExecutor): void;
}


const ZERO_ADDRESS = new Address("0:0000000000000000000000000000000000000000000000000000000000000000");
const EMPTY_STATE = "te6ccgEBAQEAAwAAAUA=";
const TEST_CODE_HASH = '4e92716de61d456e58f16e4e867e3e93a7548321eace86301b51c8b80ca6239b';
const GIVER_BOC = 'te6ccgECIQEABFoAAnaAHZyveY2KYFB32XexR2SaeLMPm7uHkW9md83JTGJJIIKkhQ+VBknFzjAAAAAAAAAAbCKxxDS+yMZIJgcBAUEq2i5lq47qsJSQ41IUFfRbbkLfnHYKY5vPU5V1ULJaFuACAgFiBgMCASAFBABRvzSrPJndvUQ61TKk+Cqu2L3CV0kGnMQRXgBDOjRs8tU8AAAAAZJxdH4AUb8rzBuq86/oRvU/aQDbWjxnNHZbnv9/+hpEJ/JT9SQ+hAAAAAGScXR+AFG/XSPMYBMlpt6yUJ+Mf4TBdDY4l9KxuF8dWpEiOsPyK/AAAAAB/////wIm/wD0pCAiwAGS9KDhiu1TWDD0oQoIAQr0pCD0oQkAAAIBIA4LAQL/DAH+fyHtRNAg10nCAZ/T/9MA9AX4an/4Yfhm+GKOG/QFbfhqcAGAQPQO8r3XC//4YnD4Y3D4Zn/4YeLTAAGOEoECANcYIPkBWPhCIPhl+RDyqN4j+EUgbpIwcN74Qrry4GUh0z/THzQg+CO88rki+QAg+EqBAQD0DiCRMd7y0Gb4AA0ANiD4SiPIyz9ZgQEA9EP4al8E0x8B8AH4R27yfAIBIBUPAgFYExABCbjomPxQEQHW+EFujhLtRNDT/9MA9AX4an/4Yfhm+GLe0XBtbwL4SoEBAPSGlQHXCz9/k3BwcOKRII4yXzPIIs8L/yHPCz8xMQFvIiGkA1mAIPRDbwI0IvhKgQEA9HyVAdcLP3+TcHBw4gI1MzHoXwMhwP8SAJiOLiPQ0wH6QDAxyM+HIM6NBAAAAAAAAAAAAAAAAA90TH4ozxYhbyICyx/0AMlx+wDeMMD/jhL4QsjL//hGzwsA+EoB9ADJ7VTef/hnAQm5Fqvn8BQAtvhBbo427UTQINdJwgGf0//TAPQF+Gp/+GH4Zvhijhv0BW34anABgED0DvK91wv/+GJw+GNw+GZ/+GHi3vhG8nNx+GbR+AD4QsjL//hGzwsA+EoB9ADJ7VR/+GcCASAZFgEJuxXvk1gXAbb4QW6OEu1E0NP/0wD0Bfhqf/hh+Gb4Yt76QNcNf5XU0dDTf9/XDACV1NHQ0gDf0VRxIMjPhYDKAHPPQM4B+gKAa89AyXP7APhKgQEA9IaVAdcLP3+TcHBw4pEgGACEjigh+CO7myL4SoEBAPRbMPhq3iL4SoEBAPR8lQHXCz9/k3BwcOICNTMx6F8G+ELIy//4Rs8LAPhKAfQAye1Uf/hnAgEgHBoBCbjkYYdQGwC++EFujhLtRNDT/9MA9AX4an/4Yfhm+GLe1NH4RSBukjBw3vhCuvLgZfgA+ELIy//4Rs8LAPhKAfQAye1U+A8g+wQg0O0e7VPwAjD4QsjL//hGzwsA+EoB9ADJ7VR/+GcCAtofHQEBSB4ALPhCyMv/+EbPCwD4SgH0AMntVPgP8gABAUggAFhwItDWAjHSADDcIccA3CHXDR/yvFMR3cEEIoIQ/////byx8nwB8AH4R27yfA==';
const GIVER_ADDRESS = '0:ece57bcc6c530283becbbd8a3b24d3c5987cdddc3c8b7b33be6e4a6312490415';


export class LockliftExecutor {
  private state: ExecutorState;
  private breakpoints: { [id: string]: ExecutorState } = {};
  private nonce: number = 0;
  private readonly blockchainConfig: string;
  private readonly globalId: number;
  private clock: nt.ClockWithOffset | undefined;
  private msgs: number = 0;

  constructor(
    private readonly transport: LockliftTransport
  ) {
    const config = transport.getBlockchainConfig();
    this.blockchainConfig = config[0];
    this.globalId = Number(config[1]);
    this.state = {
      accounts: {},
      transactions: {},
      msgToTransaction: {},
      addrToTransactions: {},
      messageQueue: new Heap<nt.JsRawMessage>(messageComparator)
    };
    // set this in order to pass standalone-client checks
    this.state.accounts[ZERO_ADDRESS.toString()] = nt.parseFullAccountBoc(nt.makeFullAccountBoc(GIVER_BOC))!;
    this.state.accounts[ZERO_ADDRESS.toString()].codeHash = TEST_CODE_HASH;
    // manually add giver account
    this.state.accounts[GIVER_ADDRESS] = nt.parseFullAccountBoc(nt.makeFullAccountBoc(GIVER_BOC))!;

    transport.setExecutor(this);
  }

  setClock(clock: nt.ClockWithOffset) {
    if (this.clock !== undefined) throw new Error('Clock already set');
    this.clock = clock;
  }

  private setAccount(address: Address | string, boc: string) {
    this.state.accounts[address.toString()] = nt.parseFullAccountBoc(boc)!;
  }

  getAccount(address: Address | string): FullContractState | undefined {
    return this.state.accounts[address.toString()];
  }

  getAccounts(): { [id: string]: FullContractState } {
    return this.state.accounts;
  }

  private saveTransaction(tx: nt.JsRawTransaction) {
    this.state.transactions[tx.hash] = tx;
    this.state.msgToTransaction[tx.inMessage.hash] = tx.hash;
    this.state.addrToTransactions[tx.inMessage.dst!] = ([tx.hash]).concat(this.state.addrToTransactions[tx.inMessage.dst!] || []);
  }

  getDstTransaction(msg_hash: string): nt.JsRawTransaction | undefined {
    // console.log('get dst tx');
    return this.state.transactions[this.state.msgToTransaction[msg_hash]];
  }

  getTransaction(id: string): nt.JsRawTransaction | undefined {
    // console.log('get transaction');
    return this.state.transactions[id];
  }

  getTransactions(address: Address | string, fromLt: string, count: number): nt.JsRawTransaction[] {
    const raw_txs = (this.state.addrToTransactions[address.toString()] || []).map((id) => this.state.transactions[id]);
    // return raw_txs;
    return raw_txs.filter((tx) => Number(tx.lt) <= Number(fromLt)).slice(0, count);
  }

  setBreakpoint(): number {
    this.breakpoints[this.nonce] = _.cloneDeep(this.state);
    // postincrement!
    console.log(this.breakpoints[this.nonce].messageQueue.size())
    return this.nonce++;
  }

  resumeBreakpoint(id: number) {
    if (this.breakpoints[id] === undefined) {
      throw new Error(`Breakpoint ${id} not found`);
    }
    this.state = this.breakpoints[id];
  }

  clearBreakpoints() {
    this.breakpoints = {};
  }

  // process all msgs in queue
  processQueue() {
    const q = Math.random();
    console.time(`processQueue ${q}`)
    const w = this.msgs;
    while (this.state.messageQueue.size() > 0) {
      this.processNextMsg();
    }
    console.timeEnd(`processQueue ${q}`)
    console.log(`processed ${this.msgs - w} messages`)
  }

  // process msg with lowest lt in queue
  processNextMsg() {
    const message = this.state.messageQueue.pop();
    // everything is processed
    if (!message) return;
    this.msgs += 1;
    const receiver_acc = this.getAccount(message.dst!);
    const res = nt.executeLocalExtended(
      this.blockchainConfig,
      receiver_acc ? nt.makeFullAccountBoc(receiver_acc.boc) : EMPTY_STATE,
      message.boc,
      Math.floor(this.clock!.nowMs / 1000),
      false,
      undefined,
      this.globalId,
      true
    );
    if ('account' in res) {
      // if (res.transaction.description.aborted) {
      //   const q = res.trace.map((t) => JSON.stringify(t)).join('\n');
      //   fs.writeFileSync('log.txt', q);
      // }
      // console.log(res.trace);
      // process.exit(1);
      this.setAccount(message.dst!, res.account);
      this.saveTransaction(res.transaction);
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
