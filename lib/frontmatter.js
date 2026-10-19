export function parseFrontmatter(text) {
    const src = String(text ?? '').replace(/^\uFEFF/, '');
    const match = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) {
      return { meta: {}, body: src };
    }
  
    const meta = {};
    for (const rawLine of match[1].split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
  
      const sep = line.indexOf(':');
      if (sep === -1) continue;
  
      const key = line.slice(0, sep).trim();
      let value = line.slice(sep + 1).trim();
  
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1).replace(/''/g, "'");
      }
  
      meta[key] = value;
    }
  
    return { meta, body: src.slice(match[0].length) };
  }
  
  export function buildNameLine(name) {
    const safe = String(name).replace(/\r?\n/g, ' ').trim();
    if (/[:#"'{}[\],&*?|<>=!%@`]/.test(safe)) {
      return JSON.stringify(safe);
    }
    return safe;
  }