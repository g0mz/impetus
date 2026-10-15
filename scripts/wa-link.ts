// Vincula o número do bot (uma vez): `npm run wa:link -- --phone 55DDNNNNNNNNN` (código de pareamento)
// ou `npm run wa:link -- --qr`. A sessão fica em data/wa-auth/ (credencial: fora do backup em nuvem).
import { DisconnectReason } from 'baileys';
import QRCode from 'qrcode';
import { createSocket } from '../src/channels/whatsapp-baileys.ts';
import { runCli } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';

const args = process.argv.slice(2);
const phone = args.includes('--phone') ? args[args.indexOf('--phone') + 1]?.replace(/\D/g, '') : undefined;
const useQr = args.includes('--qr');

await runCli(async () => {
  if (!phone && !useQr) {
    console.error('Uso: npm run wa:link -- --phone 55DDNNNNNNNNN   ou   npm run wa:link -- --qr');
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  const logger = createLogger('warn');
  const attempt = async (): Promise<void> => {
    const sock = await createSocket(config.waAuthDir, logger);
    let asked = false;
    await new Promise<void>((resolve, reject) => {
      sock.ev.on('connection.update', async (u) => {
        if (u.qr && !sock.authState.creds.registered) {
          if (phone && !asked) {
            asked = true;
            const code = await sock.requestPairingCode(phone);
            console.log(`\nCódigo de pareamento: ${code}`);
            console.log(
              'No celular do chip do bot: WhatsApp → Aparelhos conectados → Conectar com número de telefone.\n',
            );
          } else if (useQr) {
            console.log(await QRCode.toString(u.qr, { type: 'terminal', small: true }));
            console.log('Escaneie em WhatsApp → Aparelhos conectados → Conectar um aparelho.');
          }
        }
        if (u.connection === 'open') {
          // deixa terminar as gravações pendentes de creds/chaves antes de sair (no Windows o
          // process.exit no meio da escrita deixou creds.json com 0 bytes)
          await new Promise((r) => setTimeout(r, 5000));
          await sock.flushCreds();
          sock.end(undefined);
          console.log('✅ Bot vinculado. Sessão salva em', config.waAuthDir);
          resolve();
        }
        if (u.connection === 'close') {
          const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
            ?.statusCode;
          if (code === DisconnectReason.restartRequired) {
            // fluxo normal após o pareamento: reabrir com as credenciais novas
            attempt().then(resolve, reject);
          } else if (code === DisconnectReason.loggedOut) {
            reject(
              new Error(
                `sessão inválida (401): pareamento anterior incompleto ou desvinculado. Apague ${config.waAuthDir} e rode de novo.`,
              ),
            );
          } else reject(new Error(`conexão encerrada (código ${code ?? '?'})`));
        }
      });
    });
  };
  await attempt();
  process.exit(0);
});
