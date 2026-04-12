/** Storage-adapter seam for at-rest encryption: encode before write, decode after read. */
export interface TextCodec {
  encode(plaintext: string): string;
  decode(stored: string): string;
}

export const PLAIN_TEXT_CODEC: TextCodec = {
  encode: (plaintext) => plaintext,
  decode: (stored) => stored,
};
