import * as nt from "nekoton-wasm";
import {LockliftExecutor} from "./executor";
import {EMPTY_STATE, MAIN_CONFIG} from "./constants";
import {BlockchainConfig, NetworkCapabilities} from "nekoton-wasm";

export class LockliftTransport implements nt.IProxyConnector {
  private executor: LockliftExecutor | undefined;
  private cache: { [id: string]: any } = {};

  setExecutor(executor: LockliftExecutor): void {
    this.executor = executor;
  }

  info(): nt.TransportInfo {
    return {
      hasKeyBlocks: false,
      maxTransactionsPerFetch: 255,
      reliableBehavior: "IntensivePolling"
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getAccountsByCodeHash(codeHash: string, limit: number, continuation?: string): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const q = Object.entries(this.executor!.getAccounts())
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .filter(([_, state]) => state.codeHash === codeHash)
      .map(([address, _]) => address);
    return Promise.resolve(q);
  }

  // @ts-ignore
  getBlockchainConfig(): Promise<BlockchainConfig> {
    return Promise.resolve({
      boc: MAIN_CONFIG,
      globalId: 42
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getCapabilities(nowMs: string): Promise<NetworkCapabilities> {
    const config = await this.getBlockchainConfig();
    return new Promise<NetworkCapabilities>(() => {
      if (this.cache["capabilities"] === undefined) {
        const cap = nt.getCapabilitiesFromConfig(config.boc);
        this.cache["capabilities"] = {
          globalId: config.globalId,
          capabilities: cap.toString()
        };
      }
      return this.cache["capabilities"];
    });
  }

  getContractState(address: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const state = this.executor!.getAccount(address);
    return Promise.resolve(state?.boc == null ? EMPTY_STATE : state.boc);
  }

  getDstTransaction(msgHash: string): Promise<string | undefined> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return Promise.resolve(this.executor!.getDstTransaction(msgHash)?.boc);
  }

  getLatestKeyBlock(): Promise<string> {
    return Promise.resolve("");
  }

  getTransaction(id: string): Promise<string | undefined> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return Promise.resolve(this.executor!.getTransaction(id)?.boc);
  }

  getTransactions(address: string, fromLt: string, count: number): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return Promise.resolve(this.executor!.getTransactions(address, fromLt, count).map(tx => tx.boc));
  }

  sendMessage(message: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.executor!.enqueueMsg(nt.parseMessageBase64Extended(message));
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.executor!.processQueue();
    return Promise.resolve();
  }
}
