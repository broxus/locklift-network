import { Address } from "everscale-inpage-provider";

export type AccountFetcherResponse = { boc?: string; codeHash?: string; type: "accountStuffBoc" | "fullAccountBoc" };
export type AccountFetcherCallback = (address: Address) => Promise<AccountFetcherResponse>;
