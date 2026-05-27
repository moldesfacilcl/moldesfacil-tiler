const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const s3 = new S3Client({
  endpoint:    'https://sfo3.digitaloceanspaces.com',
  region:      'sfo3',
  credentials: {
    accessKeyId:     'DO00LEMCYDJQLHAVNF8U',
    secretAccessKey: 'j2wIkyJFw1rblJxjp9kx22yIQnA7oQwfGiNqgcEVjBA',
  },
  forcePathStyle: false,
});

const BUCKET = 'moldes-facil';

const FILES = [
  { local: 'dist/Moldes Fácil Tiler-1.1.0.dmg',         key: 'releases/tiler/Moldes Fácil Tiler-1.1.0.dmg' },
  { local: 'dist/Moldes Fácil Tiler-1.1.0-arm64.dmg',   key: 'releases/tiler/Moldes Fácil Tiler-1.1.0-arm64.dmg' },
  // Windows: descomenta cuando tengas el .exe
  // { local: 'dist/Moldes Fácil Tiler Setup 1.1.0.exe', key: 'releases/tiler/Moldes Fácil Tiler Setup 1.1.0.exe' },
];

async function upload(localPath, key) {
  const abs = path.join(__dirname, '..', localPath);
  if (!fs.existsSync(abs)) {
    console.error(`✗ No encontrado: ${abs}`);
    return;
  }
  const body = fs.readFileSync(abs);
  console.log(`↑ Subiendo ${path.basename(localPath)} (${(body.length / 1e6).toFixed(1)} MB)…`);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key:    key,
    Body:   body,
    ACL:    'public-read',
    ContentType: localPath.endsWith('.exe') ? 'application/octet-stream' : 'application/x-apple-diskimage',
  }));
  console.log(`✓ https://moldes-facil.sfo3.cdn.digitaloceanspaces.com/${key}`);
}

(async () => {
  for (const f of FILES) {
    await upload(f.local, f.key);
  }
})();
