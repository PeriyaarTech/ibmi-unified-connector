import { parseStringPromise } from 'xml2js';

/**
 * Parses the XML response from IBM i XMLSERVICE (QXMLSERV.iPLUG512K)
 * Returns a flat key/value map of output parameter names to their values.
 * Throws if the XMLSERVICE response contains an error.
 */
export async function parseXmlResponse(xmlOut: string): Promise<Record<string, any>> {
  const raw = xmlOut.trim();

  if (!raw.startsWith('<')) {
    throw new Error(`XMLSERVICE returned non-XML response: ${raw.substring(0, 100)}`);
  }

  // Sanitize & characters not part of XML entities
  const sanitized = raw.replace(/&(?!amp;|lt;|gt;|quot;|apos;)/g, '&amp;');

  const parsed = await parseStringPromise(sanitized, { explicitArray: false });

  // Check for XMLSERVICE-level errors
  const pgm = parsed?.script?.pgm;
  if (!pgm) {
    throw new Error(`XMLSERVICE returned unexpected structure: ${raw.substring(0, 200)}`);
  }

  // XMLSERVICE reports errors in <error> or <success> elements
  if (pgm.error) {
    const errText = typeof pgm.error === 'string' ? pgm.error : JSON.stringify(pgm.error);
    const err = new Error(`XMLSERVICE error: ${errText}`) as any;
    err.xmlServiceResponse = raw;
    throw err;
  }

  // Some versions return <success>+NN</success> for errors
  if (pgm.success && !String(pgm.success).startsWith('+')) {
    const err = new Error(`XMLSERVICE call failed: ${pgm.success}`) as any;
    err.xmlServiceResponse = raw;
    throw err;
  }

  const response: Record<string, any> = {};
  const parms = pgm.parm;

  if (!parms) return response;

  // Handle both single param (Object) and multiple params (Array)
  const parmArray = Array.isArray(parms) ? parms : [parms];

  for (const parm of parmArray) {
    const data = parm?.data;
    if (data && data.$?.name) {
      response[data.$.name] = data._ ?? '';
    }
  }

  return response;
}
