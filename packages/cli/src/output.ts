export interface CliIO {
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export const USAGE = [
  'Usage: mp-clangd <command> [args]',
  '',
  'Commands:',
  '  init                 Create .mpclangd/ and ignore it in .gitignore',
  '  refresh              Run providers and materialize compile_commands.json',
  '  profiles             List profiles produced by providers',
  '  profile [name]       Show or select the active profile',
  '  unit <file> [name]   List or select a compile unit for a file',
  '  headers <header>     Show include chains that reach a header',
  '  doctor               Check generated files and clangd settings',
  '  providers            List configured providers',
].join('\n');

export function writeError(io: CliIO, message: string): number {
  io.stderr(`error: ${message}`);
  return 1;
}
