const SBOX: number[] = []
const INV_SBOX: number[] = []

function multiply(left: number, right: number) {
  let result = 0
  let a = left
  let b = right
  while (b > 0) {
    if (b & 1) result ^= a
    a = (a << 1) ^ ((a & 0x80) ? 0x11b : 0)
    b >>>= 1
  }
  return result & 0xff
}

function power(value: number, exponent: number) {
  let result = 1
  let base = value
  let remaining = exponent
  while (remaining > 0) {
    if (remaining & 1) result = multiply(result, base)
    base = multiply(base, base)
    remaining >>>= 1
  }
  return result
}

function rotateByte(value: number, amount: number) {
  return ((value << amount) | (value >>> (8 - amount))) & 0xff
}

for (let value = 0; value < 256; value++) {
  const inverse = value === 0 ? 0 : power(value, 254)
  const substituted = inverse ^ rotateByte(inverse, 1) ^ rotateByte(inverse, 2) ^ rotateByte(inverse, 3) ^ rotateByte(inverse, 4) ^ 0x63
  SBOX[value] = substituted & 0xff
  INV_SBOX[substituted & 0xff] = value
}

function expandKey(key: number[]) {
  const expanded = key.slice(0, 16)
  let rcon = 1
  while (expanded.length < 176) {
    let word = expanded.slice(expanded.length - 4)
    if (expanded.length % 16 === 0) {
      word = [word[1], word[2], word[3], word[0]].map(value => SBOX[value])
      word[0] ^= rcon
      rcon = multiply(rcon, 2)
    }
    for (const value of word) expanded.push(expanded[expanded.length - 16] ^ value)
  }
  return expanded
}

function addRoundKey(state: number[], keys: number[], round: number) {
  const offset = round * 16
  for (let index = 0; index < 16; index++) state[index] ^= keys[offset + index]
}

function inverseSubBytes(state: number[]) {
  for (let index = 0; index < 16; index++) state[index] = INV_SBOX[state[index]]
}

function inverseShiftRows(state: number[]) {
  const copy = state.slice()
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      state[column * 4 + row] = copy[((column - row + 4) % 4) * 4 + row]
    }
  }
}

function inverseMixColumns(state: number[]) {
  for (let column = 0; column < 4; column++) {
    const offset = column * 4
    const a = state[offset]
    const b = state[offset + 1]
    const c = state[offset + 2]
    const d = state[offset + 3]
    state[offset] = multiply(a, 14) ^ multiply(b, 11) ^ multiply(c, 13) ^ multiply(d, 9)
    state[offset + 1] = multiply(a, 9) ^ multiply(b, 14) ^ multiply(c, 11) ^ multiply(d, 13)
    state[offset + 2] = multiply(a, 13) ^ multiply(b, 9) ^ multiply(c, 14) ^ multiply(d, 11)
    state[offset + 3] = multiply(a, 11) ^ multiply(b, 13) ^ multiply(c, 9) ^ multiply(d, 14)
  }
}

function decryptBlock(block: number[], keys: number[]) {
  const state = block.slice()
  addRoundKey(state, keys, 10)
  for (let round = 9; round > 0; round--) {
    inverseShiftRows(state)
    inverseSubBytes(state)
    addRoundKey(state, keys, round)
    inverseMixColumns(state)
  }
  inverseShiftRows(state)
  inverseSubBytes(state)
  addRoundKey(state, keys, 0)
  return state
}

function hexBytes(value: string) {
  if (!/^(?:[0-9a-f]{2})*$/i.test(value)) throw new Error("站点返回的加密数据格式异常")
  const bytes: number[] = []
  for (let index = 0; index < value.length; index += 2) bytes.push(parseInt(value.slice(index, index + 2), 16))
  return bytes
}

function utf8Bytes(value: string) {
  const bytes: number[] = []
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(++index)
      const point = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00
      bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f))
    } else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
  }
  return bytes
}

function utf8String(bytes: number[]) {
  let result = ""
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++]
    if (first < 0x80) result += String.fromCharCode(first)
    else if (first < 0xe0) result += String.fromCharCode(((first & 0x1f) << 6) | (bytes[index++] & 0x3f))
    else if (first < 0xf0) result += String.fromCharCode(((first & 0x0f) << 12) | ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f))
    else {
      const point = ((first & 7) << 18) | ((bytes[index++] & 0x3f) << 12) | ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f)
      const adjusted = point - 0x10000
      result += String.fromCharCode(0xd800 | (adjusted >> 10), 0xdc00 | (adjusted & 0x3ff))
    }
  }
  return result
}

export function decryptAES128CBC(cipherHexWithIV: string, keyText: string) {
  if (cipherHexWithIV.length < 32) throw new Error("站点返回的加密数据为空")
  const iv = utf8Bytes(cipherHexWithIV.slice(0, 16))
  const encrypted = hexBytes(cipherHexWithIV.slice(16))
  const key = utf8Bytes(keyText)
  if (iv.length !== 16 || key.length !== 16 || encrypted.length === 0 || encrypted.length % 16 !== 0) {
    throw new Error("站点加密参数不完整")
  }

  const keys = expandKey(key)
  const output: number[] = []
  let previous = iv
  for (let offset = 0; offset < encrypted.length; offset += 16) {
    const decrypted = decryptBlock(encrypted.slice(offset, offset + 16), keys)
    for (let index = 0; index < 16; index++) output.push(decrypted[index] ^ previous[index])
    previous = encrypted.slice(offset, offset + 16)
  }

  const padding = output[output.length - 1]
  if (!padding || padding > 16 || output.slice(-padding).some(value => value !== padding)) {
    throw new Error("站点加密数据校验失败")
  }
  return utf8String(output.slice(0, output.length - padding))
}

export function decryptJSON<T>(cipherHexWithIV: string, keyText: string): T {
  return JSON.parse(decryptAES128CBC(cipherHexWithIV, keyText)) as T
}
