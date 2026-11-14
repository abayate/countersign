// Creates a devnet keypair for the decision ledger and funds it from the faucet.
// Usage: node scripts/solana-setup.js   -> prints the SOLANA_SECRET_KEY line for .env
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';

const rpc = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const kp = Keypair.generate();
console.log(`Public key: ${kp.publicKey.toBase58()}`);
console.log(`\nAdd this line to .env (devnet only, never reuse for real funds):\nSOLANA_SECRET_KEY=${JSON.stringify([...kp.secretKey])}\n`);
try {
  const conn = new Connection(rpc, 'confirmed');
  const sig = await conn.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
  const bh = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
  console.log(`Funded with 1 devnet SOL (${sig}).`);
} catch (err) {
  console.log(`Faucet request failed (${err.message.slice(0, 120)}).`);
  console.log(`Fund it by hand at https://faucet.solana.com with the public key above.`);
}
