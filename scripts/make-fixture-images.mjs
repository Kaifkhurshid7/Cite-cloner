import sharp from 'sharp';
const mk = (file, w, h, a, b) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w*0.7}" cy="${h*0.4}" r="${h*0.25}" fill="white" fill-opacity="0.25"/></svg>`)).jpeg({quality:80}).toFile(file);
await mk('fixtures/saas/img/dashboard.jpg', 1100, 640, '#635bff', '#00d4ff');
await mk('fixtures/bakery/img/hero.jpg', 1600, 900, '#7a4b2a', '#e8b27d');
for (const [i,c] of [['#c98b4f','#f6d8b0'],['#8a5a3b','#d9a066'],['#e3b778','#fff1d6']].entries()) await mk(`fixtures/bakery/img/p${i}.jpg`, 600, 450, c[0], c[1]);
for (let i=0;i<6;i++) await mk(`fixtures/portfolio/img/w${i}.jpg`, 800, 600, ['#111827','#1e3a8a','#831843','#064e3b','#78350f','#312e81'][i], '#e5e7eb');
await mk('fixtures/portfolio/img/me.jpg', 400, 400, '#374151', '#9ca3af');
console.log('ok');
