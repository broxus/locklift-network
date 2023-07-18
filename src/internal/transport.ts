import * as nt from "nekoton-wasm";
import { LockliftExecutor } from "./executor";
import { MAIN_CONFIG } from "./constants";

export class LockliftTransport implements nt.IProxyConnector {
  private executor: LockliftExecutor | undefined;
  private cache: { [id: string]: any } = {};

  setExecutor(executor: LockliftExecutor): void {
    this.executor = executor;
  }

  info(): nt.TransportInfo {
    return {
      // eslint-disable-next-line camelcase
      max_transactions_per_fetch: 255,
      // eslint-disable-next-line camelcase
      reliable_behavior: "IntensivePolling",
      // eslint-disable-next-line camelcase
      has_key_blocks: false,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getAccountsByCodeHash(codeHash: string, limit: number, continuation?: string): string[] {
    return Object.entries(this.executor!.getAccounts())
      .filter(([_, state]) => state.codeHash === codeHash)
      .map(([address, _]) => address);
  }

  // @ts-ignore
  getBlockchainConfig(): string[] {
    return [MAIN_CONFIG, "42"];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getCapabilities(clock_offset_as_sec: string, clock_offset_as_ms: string): string[] {
    if (this.cache["capabilities"] === undefined) {
      const config = this.getBlockchainConfig();
      const cap = nt.getCapabilitiesFromConfig(config[0]);
      this.cache["capabilities"] = [config[1], cap.toString()];
    }
    return this.cache["capabilities"];
  }

  getContractState(address: string): nt.RawContractState | undefined {
    const acc = this.executor!.getAccount(address);
    if (acc !== undefined) {
      return {
        account: acc.boc,
        lastTransactionId: acc.lastTransactionId!,
        timings: acc.genTimings,
        type: "exists",
      };
    }
  }

  getDstTransaction(msg_hash: string): string | undefined {
    return this.executor!.getDstTransaction(msg_hash)?.boc;
  }

  getLatestKeyBlock(): string {
    return "";
  }

  getTransaction(id: string): string | undefined {
    return this.executor!.getTransaction(id)?.boc;
  }

  getTransactions(address: string, fromLt: string, count: number): string[] {
    return this.executor!.getTransactions(address, fromLt, count).map(tx => tx.boc);
  }

  sendMessage(message: string): void {
    this.executor!.enqueueMsg(nt.parseMessageBase64Extended(message));
    this.executor!.processQueue();
  }
}
