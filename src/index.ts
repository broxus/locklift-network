import * as nt from "nekoton-wasm";
import {ConnectionFactory} from "everscale-standalone-client/nodejs";
import {LockliftExecutor} from "./internal/executor";
import {LockliftTransport} from "./internal/transport";


export class LockliftNetwork {
  private readonly _transport: LockliftTransport;
  private readonly _connectionFactory: ConnectionFactory;
  private readonly _executor: LockliftExecutor;

  constructor() {
    this._transport = new LockliftTransport();
    this._executor = new LockliftExecutor(this._transport);

    const _onClock = (clock: nt.ClockWithOffset) => {
      this._executor.setClock(clock);
    }

    this._connectionFactory = new ProxyConnectionFactory(this._transport, _onClock);
  }

  get connectionFactory(): ConnectionFactory {
    return this._connectionFactory;
  }

  getTxTrace(tx_hash: string): nt.EngineTraceInfo[] | undefined {
    return this._executor.getTxTrace(tx_hash);
  }
}

class ProxyConnectionFactory implements ConnectionFactory {
  constructor(
    private readonly transport: LockliftTransport,
    private readonly clockHandler: (clock: nt.ClockWithOffset) => void
  ) {}

  create(clock: nt.ClockWithOffset): nt.ProxyConnection {
    this.clockHandler(clock);
    return new nt.ProxyConnection(clock, this.transport);
  }
}
