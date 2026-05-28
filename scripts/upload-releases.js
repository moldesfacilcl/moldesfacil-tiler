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
  { local: 'dist/Moldes Fácil Tiler-1.1.0.dmg',         key: 'releases/tiler/Moldes Fácil Tiler-1.1.0.dmg',       type: 'application/x-apple-diskimage' },
  { local: 'dist/Moldes Fácil Tiler-1.1.0-arm64.dmg',   key: 'releases/tiler/Moldes Fácil Tiler-1.1.0-arm64.dmg', type: 'application/x-apple-diskimage' },
  { local: 'releases/latest.json',                       key: 'releases/tiler/latest.json',                        type: 'application/json' },
  // Windows: descomenta cuando tengas el .exe
  // { local: 'dist/Moldes Fácil Tiler Setup 1.1.0.exe', key: 'releases/tiler/Moldes Fácil Tiler Setup 1.1.0.exe', type: 'application/octet-stream' },
];

async function upload({ local, key, type }) {
  const abs = path.join(__dirname, '..', local);
  if (!fs.existsSync(abs)) {
    console.error(`✗ No encontrado: ${abs}`);
    return;
  }
  const body = fs.readFileSync(abs);
  console.log(`↑ Subiendo ${path.basename(local)} (${(body.length / 1e6).toFixed(1)} MB)…`);
  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        body,
    ACL:         'public-read',
    ContentType: type,
  }));
  console.log(`✓ https://moldes-facil.sfo3.cdn.digitaloceanspaces.com/${key}`);
}

(async () => {
  for (const f of FILES) {
    await upload(f);
  }
})();
