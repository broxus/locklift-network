import * as nt from "nekoton-wasm";
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
