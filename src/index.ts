import * as nt from "nekoton-wasm";
import { ConnectionFactory } from "everscale-standalone-client/nodejs";
import { LockliftExecutor } from "./internal/executor";
import { LockliftTransport } from "./internal/transport";
import { AccountFetcherCallback } from "./types";

export class LockliftNetwork {
  private readonly _transport: LockliftTransport;
  private readonly _connectionFactory: ConnectionFactory;
  private readonly _executor: LockliftExecutor;

  constructor(config?: { accountFetcher?: AccountFetcherCallback } | undefined) {
    this._transport = new LockliftTransport();
    this._executor = new LockliftExecutor(this._transport, config?.accountFetcher);

    const _onClock = (clock: nt.ClockWithOffset) => {
      this._executor.setClock(clock);
    };

    this._connectionFactory = new ProxyConnectionFactory(this._transport, _onClock);
  }

  async initialize() {
    await this._executor.initialize();
  }

  setAccount: LockliftExecutor["setAccount"] = (...params) => this._executor.setAccount(...params);

  get connectionFactory(): ConnectionFactory {
    return this._connectionFactory;
  }

  getTxTrace(txHash: string): nt.EngineTraceInfo[] | undefined {
    return this._executor.getTxTrace(txHash);
  }
}

class ProxyConnectionFactory implements ConnectionFactory {
  constructor(
    private readonly transport: LockliftTransport,
    private readonly clockHandler: (clock: nt.ClockWithOffset) => void,
  ) {}

  create(clock: nt.ClockWithOffset): nt.ProxyConnection {
    this.clockHandler(clock);
    return new nt.ProxyConnection(this.transport);
  }
}
