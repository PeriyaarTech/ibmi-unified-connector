declare module 'itoolkit' {
  export class Connection {
    constructor(options: {
      transport: 'rest' | 'ssh' | 'idb2' | 'idb' | 'odbc';
      transportOptions: {
        url?: string;         // REST: full URL e.g. http://host:port/path
        database?: string;    // default *LOCAL
        username?: string;    // user to connect as
        password?: string;    // user password
        host?: string;        // SSH: hostname
        ipc?: string;         // default *NA
        ctl?: string;         // default *here
        [key: string]: any;
      };
      verbose?: boolean;
    });
    add(call: any): void;
    run(callback: (xmlOut: string) => void): void;
  }

  export class ProgramCall {
    constructor(
      programName: string,
      options?: { lib?: string; func?: string; [key: string]: any }
    );
    addParam(param: { type: string; value: string; io?: string; [key: string]: any }): void;
  }

  export function xmlToJson(xml: string): any;
}
