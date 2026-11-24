import { saveBlob, saveBytes, type SaveEnvironment } from './download';
import type { JobOutput } from './types';
import { zipFiles } from './zip';

/**
 * A job's result as the list of files it is.
 *
 * Most results are one file. A split or a render of many pages is several,
 * and `JobOutput` carries the first as itself and the rest as siblings; code
 * that read only `bytes` and `name` saved the first part and reported the job
 * as saved. Everything that writes or counts a result goes through here so
 * that mistake has one place to be made.
 */
export interface OutputFile {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

export function outputFiles(output: JobOutput): OutputFile[] {
  return [
    { name: output.name, bytes: output.bytes, mime: output.mime },
    ...(output.siblings ?? []),
  ];
}

/**
 * Writes a result to disk: the file itself when it is one, an archive of
 * them when it is several, because a save dialog per page of a 200-page
 * document is not a thing anyone should be asked to survive.
 *
 * @param archiveName what the archive is called, when there is one.
 * @returns true when something was written, false when the person cancelled.
 */
export async function saveOutput(
  output: JobOutput,
  archiveName: string,
  environment?: SaveEnvironment,
): Promise<boolean> {
  if (!output.siblings?.length) {
    return saveBytes(output.bytes, output.name, output.mime, environment);
  }
  const archive = await zipFiles(outputFiles(output));
  return saveBlob(archive, archiveName, environment);
}
