import { describe, expect, it } from 'vitest';
import { safeName, uniqueName } from './zip';

describe('uniqueName', () => {
  it('leaves the first occurrence alone', () => {
    const used = new Map<string, number>();
    expect(uniqueName(used, 'photo.jpg')).toBe('photo.jpg');
  });

  it('numbers repeats instead of overwriting them', () => {
    const used = new Map<string, number>();
    uniqueName(used, 'photo.jpg');
    expect(uniqueName(used, 'photo.jpg')).toBe('photo (2).jpg');
    expect(uniqueName(used, 'photo.jpg')).toBe('photo (3).jpg');
  });

  it('keeps the extension at the end', () => {
    const used = new Map<string, number>();
    uniqueName(used, 'scan.tar.gz');
    expect(uniqueName(used, 'scan.tar.gz')).toBe('scan.tar (2).gz');
  });

  it('handles names with no extension', () => {
    const used = new Map<string, number>();
    uniqueName(used, 'README');
    expect(uniqueName(used, 'README')).toBe('README (2)');
  });

  it('does not collide with a name that already looks numbered', () => {
    const used = new Map<string, number>();
    uniqueName(used, 'photo (2).jpg');
    uniqueName(used, 'photo.jpg');
    expect(uniqueName(used, 'photo.jpg')).toBe('photo (3).jpg');
  });
});

describe('safeName', () => {
  it('strips any path, so an entry cannot escape the archive', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('..\\..\\windows\\system32\\a.dll')).toBe('a.dll');
    expect(safeName('/absolute/photo.jpg')).toBe('photo.jpg');
  });

  it('keeps an ordinary name intact', () => {
    expect(safeName('holiday photo (1).jpeg')).toBe('holiday photo (1).jpeg');
  });

  it('never returns an empty or dot-only name', () => {
    expect(safeName('..')).toBe('file');
    expect(safeName('/')).toBe('file');
    expect(safeName('')).toBe('file');
  });

  it('removes control characters', () => {
    expect(safeName('a\u0000b.txt')).toBe('ab.txt');
  });
});

describe('safeName hardening', () => {
  it('keeps a dotfile a dotfile', () => {
    expect(safeName('.gitignore')).toBe('.gitignore');
    expect(safeName('.env.local')).toBe('.env.local');
  });

  it('still refuses a name made only of dots', () => {
    expect(safeName('...')).toBe('file');
    expect(safeName('.')).toBe('file');
  });

  it('removes bidirectional overrides used to disguise an extension', () => {
    // "report‮gnp.exe" renders as "reportexe.png" in most file managers.
    expect(safeName('report‮gnp.exe')).toBe('reportgnp.exe');
  });

  it('trims the stem rather than the extension on a very long name', () => {
    const long = `${'a'.repeat(400)}.jpg`;
    const result = safeName(long);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith('.jpg')).toBe(true);
  });
});
