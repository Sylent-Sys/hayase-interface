declare module "matroska-metadata" {
  export default class Metadata {
    constructor(file: any);
    parseStream(stream: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>;
    getTracks(): Promise<any[]>;
    getAttachments(): Promise<Array<{ filename: string; mimetype: string }>>;
    on(
      event: "subtitle",
      listener: (subtitle: unknown, trackNumber: number) => void,
    ): this;
    off(
      event: "subtitle",
      listener: (subtitle: unknown, trackNumber: number) => void,
    ): this;
    removeAllListeners(event?: string): this;
  }
}
