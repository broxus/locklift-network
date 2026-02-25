import * as nt from "nekoton-wasm";
import { LockliftExecutor } from "./executor";
import { EMPTY_STATE, EVER_MAIN_CONFIG, TEST_CODE_HASH, TON_CONFIG, TYCHO_CONFIG, ZERO_ADDRESS } from "./constants";
import { BlockchainConfig, NetworkCapabilities } from "nekoton-wasm";

export class LockliftTransport implements nt.IProxyConnector {
  private executor: LockliftExecutor | undefined;
  private cache: { [id: string]: any } = {};
  private readonly networkConfig: string;
  constructor(networkConfig: "EVER" | "TON" | "TYCHO-TESTNET" | { custom: string } | undefined) {
    if (typeof networkConfig === "object") {
      this.networkConfig = networkConfig.custom;
      console.log("Locklift network is using custom blockchain config");
      return;
    }
    if (networkConfig === "TON") {
      this.networkConfig = TON_CONFIG;
      console.log("Locklift network is using TON blockchain config");
      return;
    }
    if (networkConfig === "EVER") {
      this.networkConfig = EVER_MAIN_CONFIG;
      console.log("Locklift network is using TYCHO blockchain config");
      return;
    }
    this.networkConfig = TYCHO_CONFIG;
    console.log("Locklift network is using TYCHO-TESTNET blockchain");
  }

  getLibraryCell(hash: string): Promise<string | undefined> {
    throw new Error("Method not implemented.");
  }

  setExecutor(executor: LockliftExecutor): void {
    this.executor = executor;
  }

  info(): nt.TransportInfo {
    return {
      hasKeyBlocks: false,
      maxTransactionsPerFetch: 255,
      reliableBehavior: "IntensivePolling",
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getAccountsByCodeHash(codeHash: string, limit: number, continuation?: string): Promise<string[]> {
    if (codeHash === TEST_CODE_HASH) {
      return [ZERO_ADDRESS.toString()];
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const q = Object.entries(this.executor!.getAccounts())
      .filter(([_, state]) => state.codeHash === codeHash)
      .map(([address, _]) => address);
    return q;
  }

  // @ts-ignore
  getBlockchainConfig(): Promise<BlockchainConfig> {
    return Promise.resolve({
      boc: this.networkConfig,
      globalId: 42,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getCapabilities(nowMs: string): Promise<NetworkCapabilities> {
    const config = await this.getBlockchainConfig();
    if (this.cache["capabilities"] == null) {
      const cap = nt.getCapabilitiesFromConfig(config.boc);
      this.cache["capabilities"] = {
        globalId: config.globalId,
        raw: Number(cap),
      };
    }
    return Promise.resolve(this.cache["capabilities"]);
  }

  async getContractState(address: string): Promise<string> {
    const state = await this.executor!._getAccount(address);
    return state ? nt.parseShardAccountBoc(state)?.boc || EMPTY_STATE : EMPTY_STATE;
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

  async sendMessage(message: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.executor!.enqueueMsg(nt.parseMessageBase64Extended(message));
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await this.executor!.processQueue();
    return Promise.resolve();
  }
}
