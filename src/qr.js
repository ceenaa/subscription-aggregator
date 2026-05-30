const ECC_CODEWORDS_PER_BLOCK_MEDIUM = [-1, 10, 16, 26, 18, 24, 16];
const NUM_ERROR_CORRECTION_BLOCKS_MEDIUM = [-1, 1, 1, 1, 2, 2, 4];

function appendBits(buffer, value, length) {
  for (let index = length - 1; index >= 0; index -= 1) {
    buffer.push((value >>> index) & 1);
  }
}

function getRawDataCodewords(version) {
  let result = (16 * version + 128) * version + 64;

  if (version >= 2) {
    const alignmentCount = Math.floor(version / 7) + 2;
    result -= (25 * alignmentCount - 10) * alignmentCount - 55;
  }

  return Math.floor(result / 8);
}

function getDataCapacityCodewords(version) {
  return (
    getRawDataCodewords(version) -
    ECC_CODEWORDS_PER_BLOCK_MEDIUM[version] * NUM_ERROR_CORRECTION_BLOCKS_MEDIUM[version]
  );
}

function chooseVersion(byteLength) {
  for (let version = 1; version <= 6; version += 1) {
    const capacityBits = getDataCapacityCodewords(version) * 8;
    const requiredBits = 4 + 8 + byteLength * 8;
    if (requiredBits <= capacityBits) return version;
  }

  throw new Error('Subscription URL is too long for the built-in QR renderer');
}

function buildDataCodewords(text, version) {
  const bytes = new TextEncoder().encode(text);
  const dataCapacity = getDataCapacityCodewords(version);
  const bits = [];

  appendBits(bits, 0x4, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);

  appendBits(bits, 0, Math.min(4, dataCapacity * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const data = [];
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value << 1) | bits[index + bit];
    }
    data.push(value);
  }

  for (let pad = 0xec; data.length < dataCapacity; pad ^= 0xec ^ 0x11) {
    data.push(pad);
  }

  return data;
}

function reedSolomonMultiply(x, y) {
  let product = 0;
  for (let index = 7; index >= 0; index -= 1) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((y >>> index) & 1) * x;
  }
  return product;
}

function reedSolomonGenerator(degree) {
  const result = Array(degree).fill(0);
  result[degree - 1] = 1;

  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    for (let term = 0; term < degree; term += 1) {
      result[term] = reedSolomonMultiply(result[term], root);
      if (term + 1 < degree) result[term] ^= result[term + 1];
    }
    root = reedSolomonMultiply(root, 0x02);
  }

  return result;
}

function reedSolomonRemainder(data, generator) {
  const result = Array(generator.length).fill(0);

  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let index = 0; index < result.length; index += 1) {
      result[index] ^= reedSolomonMultiply(generator[index], factor);
    }
  }

  return result;
}

function addErrorCorrection(data, version) {
  const blockCount = NUM_ERROR_CORRECTION_BLOCKS_MEDIUM[version];
  const blockEccLength = ECC_CODEWORDS_PER_BLOCK_MEDIUM[version];
  const rawCodewords = getRawDataCodewords(version);
  const shortBlockCount = blockCount - (rawCodewords % blockCount);
  const shortBlockLength = Math.floor(rawCodewords / blockCount);
  const generator = reedSolomonGenerator(blockEccLength);
  const blocks = [];

  let offset = 0;
  for (let index = 0; index < blockCount; index += 1) {
    const dataLength = shortBlockLength - blockEccLength + (index < shortBlockCount ? 0 : 1);
    const blockData = data.slice(offset, offset + dataLength);
    offset += dataLength;

    const ecc = reedSolomonRemainder(blockData, generator);
    if (index < shortBlockCount) blockData.push(0);
    blocks.push([...blockData, ...ecc]);
  }

  const result = [];
  for (let index = 0; index < blocks[0].length; index += 1) {
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      if (index === shortBlockLength - blockEccLength && blockIndex < shortBlockCount) continue;
      result.push(blocks[blockIndex][index]);
    }
  }

  return result;
}

function alignmentPositions(version, size) {
  if (version === 1) return [];

  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];

  for (let position = size - 7; result.length < count; position -= step) {
    result.splice(1, 0, position);
  }

  return result;
}

function getFormatBits(mask) {
  const data = mask;
  let remainder = data << 10;

  for (let index = 14; index >= 10; index -= 1) {
    if (((remainder >>> index) & 1) !== 0) {
      remainder ^= 0x537 << (index - 10);
    }
  }

  return ((data << 10) | remainder) ^ 0x5412;
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function makeMatrix(version, codewords, mask) {
  const size = 21 + (version - 1) * 4;
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));

  const setFunctionModule = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark;
    reserved[y][x] = true;
  };

  const drawFinder = (centerX, centerY) => {
    for (let y = -4; y <= 4; y += 1) {
      for (let x = -4; x <= 4; x += 1) {
        const distance = Math.max(Math.abs(x), Math.abs(y));
        setFunctionModule(centerX + x, centerY + y, distance !== 2 && distance !== 4);
      }
    }
  };

  const drawAlignment = (centerX, centerY) => {
    for (let y = -2; y <= 2; y += 1) {
      for (let x = -2; x <= 2; x += 1) {
        const distance = Math.max(Math.abs(x), Math.abs(y));
        setFunctionModule(centerX + x, centerY + y, distance !== 1);
      }
    }
  };

  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  const align = alignmentPositions(version, size);
  for (const y of align) {
    for (const x of align) {
      if (reserved[y][x]) continue;
      drawAlignment(x, y);
    }
  }

  for (let index = 0; index < size; index += 1) {
    if (!reserved[6][index]) setFunctionModule(index, 6, index % 2 === 0);
    if (!reserved[index][6]) setFunctionModule(6, index, index % 2 === 0);
  }

  for (let index = 0; index < 8; index += 1) {
    setFunctionModule(8, index, false);
    setFunctionModule(index, 8, false);
    setFunctionModule(size - 1 - index, 8, false);
    setFunctionModule(8, size - 1 - index, false);
  }
  setFunctionModule(8, size - 8, true);

  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;

    for (let vertical = 0; vertical < size; vertical += 1) {
      const y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        if (reserved[y][x]) continue;

        const dark =
          bitIndex < codewords.length * 8 &&
          (((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0);
        modules[y][x] = maskBit(mask, x, y) ? !dark : dark;
        bitIndex += 1;
      }
    }
  }

  const formatBits = getFormatBits(mask);
  for (let index = 0; index <= 5; index += 1) setFunctionModule(8, index, ((formatBits >>> index) & 1) !== 0);
  setFunctionModule(8, 7, ((formatBits >>> 6) & 1) !== 0);
  setFunctionModule(8, 8, ((formatBits >>> 7) & 1) !== 0);
  setFunctionModule(7, 8, ((formatBits >>> 8) & 1) !== 0);
  for (let index = 9; index < 15; index += 1) setFunctionModule(14 - index, 8, ((formatBits >>> index) & 1) !== 0);
  for (let index = 0; index < 8; index += 1) setFunctionModule(size - 1 - index, 8, ((formatBits >>> index) & 1) !== 0);
  for (let index = 8; index < 15; index += 1) setFunctionModule(8, size - 15 + index, ((formatBits >>> index) & 1) !== 0);

  return modules;
}

function penaltyScore(modules) {
  const size = modules.length;
  let penalty = 0;

  for (let y = 0; y < size; y += 1) {
    let runColor = modules[y][0];
    let runLength = 1;
    for (let x = 1; x < size; x += 1) {
      if (modules[y][x] === runColor) {
        runLength += 1;
      } else {
        if (runLength >= 5) penalty += runLength - 2;
        runColor = modules[y][x];
        runLength = 1;
      }
    }
    if (runLength >= 5) penalty += runLength - 2;
  }

  for (let x = 0; x < size; x += 1) {
    let runColor = modules[0][x];
    let runLength = 1;
    for (let y = 1; y < size; y += 1) {
      if (modules[y][x] === runColor) {
        runLength += 1;
      } else {
        if (runLength >= 5) penalty += runLength - 2;
        runColor = modules[y][x];
        runLength = 1;
      }
    }
    if (runLength >= 5) penalty += runLength - 2;
  }

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = modules[y][x];
      if (
        color === modules[y][x + 1] &&
        color === modules[y + 1][x] &&
        color === modules[y + 1][x + 1]
      ) {
        penalty += 3;
      }
    }
  }

  let dark = 0;
  for (const row of modules) {
    for (const module of row) if (module) dark += 1;
  }

  penalty += Math.floor(Math.abs((dark * 20) / (size * size) - 10)) * 10;
  return penalty;
}

export function renderQrSvg(text, options = {}) {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const data = buildDataCodewords(text, version);
  const codewords = addErrorCorrection(data, version);

  let bestModules = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = makeMatrix(version, codewords, mask);
    const penalty = penaltyScore(modules);
    if (penalty < bestPenalty) {
      bestModules = modules;
      bestPenalty = penalty;
    }
  }

  const border = options.border ?? 4;
  const scale = options.scale ?? 8;
  const size = bestModules.length;
  const viewSize = (size + border * 2) * scale;
  const rects = [];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (bestModules[y][x]) {
        rects.push(`<rect x="${(x + border) * scale}" y="${(y + border) * scale}" width="${scale}" height="${scale}"/>`);
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" role="img" aria-label="Subscription QR code"><rect width="100%" height="100%" fill="#fff"/>` +
    `<g fill="#000">${rects.join('')}</g></svg>`;
}
