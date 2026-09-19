declare module 'idb-connector' {
  export class dbconn {
    conn(system: string): void;
    disconn(): void;
    close(): void;
  }
  export class dbstmt {
    constructor(conn: dbconn);
    exec(sql: string, callback: (rows: any[], err: Error) => void): void;
    close(): void;
  }
}
