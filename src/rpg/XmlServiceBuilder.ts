import { Builder } from 'xml2js';
import type { RpgParam } from '../types.js';

/**
 * Builds the XML payload for IBM i XMLSERVICE (QXMLSERV.iPLUG512K)
 * Format: <script><pgm name="PGM" lib="LIB"><parm><data type="..." name="...">value</data></parm></pgm></script>
 */
export function buildXmlPayload(
  programName: string,
  library: string | undefined,
  paramDefs: RpgParam[],
  inputValues: Record<string, any>
): string {
  // If library is unresolved placeholder (e.g. ${PGM_LIBRARY} not set) or empty, use *LIBL
  const resolvedLib = (!library || library.startsWith('${')) ? undefined : library;

  const params = paramDefs.map(def => ({
    data: {
      $: {
        type: def.type,
        name: def.name
      },
      _: inputValues[def.name] !== undefined ? String(inputValues[def.name]) : ''
    }
  }));

  const pgmAttrs: Record<string, string> = { name: programName };
  if (resolvedLib) pgmAttrs.lib = resolvedLib;

  const payload = {
    script: {
      pgm: {
        $: pgmAttrs,
        parm: params
      }
    }
  };

  const builder = new Builder();
  return builder.buildObject(payload);
}
