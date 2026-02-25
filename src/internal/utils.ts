import * as nt from "nekoton-wasm";
import { Account, beginCell, Cell, loadAccount, ShardAccount, storeAccount, storeShardAccount } from "@ton/core";
import { GIVER_BOC } from "./constants";
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

export const shardAccountFromBoc = (boc: string, lastTxLt?: bigint, newBalance?: bigint): ShardAccount => {
  const a = nt.parseFullAccountBoc(boc);
  const acc = a?.boc ? loadAccount(Cell.fromBase64(a.boc).beginParse()) : null;
  let lastTransactionLt = acc?.storage.lastTransLt || 0n;
  if (lastTxLt != undefined) {
    lastTransactionLt = lastTxLt;
  }
  let balance = acc?.storage.balance.coins || 0n;
  if (newBalance != undefined) {
    balance = newBalance;
  }
  return {
    account: acc
      ? {
          ...acc,
          storage: {
            ...acc.storage,
            lastTransLt: lastTransactionLt,
            balance: {
              ...acc.storage.balance,
              coins: balance,
            },
          },
        }
      : null,
    lastTransactionHash: 0n,

    lastTransactionLt: lastTransactionLt,
  };
};

export const bocFromShardAccount = (shardAccount: ShardAccount): string => {
  return beginCell().store(storeShardAccount(shardAccount)).endCell().toBoc().toString("base64");
};
