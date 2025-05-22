import * as nt from "nekoton-wasm";
import { Account, beginCell, Cell, loadAccount, ShardAccount, storeAccount } from "@ton/core";
export const parseBlocks = (input: string): Array<nt.EngineTraceInfo> => {
  const blocks = input.trim().split(/(?=stack: \[)/); // разбиваем на блоки

  return blocks.map((block, idx) => {
    const stackMatch = block.match(/stack:\s*\[(.*?)\]/s);
    const stack = stackMatch ? stackMatch[1].trim().split(/\s+/) : [];

    const codeMatch = block.match(/code cell hash:\s*([a-f0-9]+):(\d+):\d+/i);
    const cmdCodeCellHash = codeMatch?.[1] || "";
    const cmdCodeOffset = codeMatch?.[2] || "";

    const execMatch = block.match(/execute\s+(.*)/i);
    const cmdStr = execMatch?.[1]?.trim() || "";

    return {
      infoType: "Normal",
      step: idx + 1,
      cmdStr,
      stack,
      cmdCodeCellHash,
      cmdCodeOffset,
      gasCmd: "0",
      gasUsed: "0",
      cmdCodeHex: "",
      cmdCodeRemBits: "",
    };
  });
};

export const shardAccountFromBoc = (boc: string, lastTxLt?: bigint): ShardAccount => {
  const a = nt.parseFullAccountBoc(boc);
  const acc = a?.boc ? loadAccount(Cell.fromBase64(a.boc).beginParse()) : null;
  return {
    account: acc,
    lastTransactionHash: 0n,

    lastTransactionLt: lastTxLt || acc?.storage.lastTransLt || 0n,
  };
};

export const fullContractStateFromShardAccount = (shardAccount: ShardAccount): nt.FullContractState => {
  const b = beginCell();
  storeAccount(shardAccount.account as Account)(b);

  const accountBoc = nt.makeFullAccountBoc(b.endCell().toBoc().toString("base64"));

  return {
    balance: shardAccount.account?.storage?.balance.coins?.toString() || "0",
    genTimings: {
      // genLt: shardAccount.account?.storage.lastTransLt.toString() || "0",
      genLt: "0",
      genUtime: 0,
    },
    lastTransactionId: {
      lt: shardAccount.lastTransactionLt.toString(),

      hash: shardAccount.lastTransactionHash.toString(),
      isExact: false,
    },
    isDeployed: shardAccount.account?.storage.state.type === "active",
    codeHash:
      shardAccount.account?.storage.state.type === "active"
        ? shardAccount.account.storage.state.state.code?.hash().toString("hex")
        : undefined,
    boc: accountBoc,
  };
};
