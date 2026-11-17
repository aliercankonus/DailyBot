# Plan

Hedef: önce para kazandıran bir stratejiyi kanıtlamak, sonra onu borsa ile senkron çalışan sade bir motorla işletmek. Her faz bir **geç/kal kapısıyla** biter; kriter tutmazsa sonraki faza geçilmez.

Kararlar: TypeScript, Binance USDⓈ-M Futures (long + short, isolated margin, one-way mode), Hostinger VPS üzerinde Docker Compose, 4h zaman dilimi ile başlangıç.

## Faz 0: Eski sistemi güvenceye al
- [ ] Binance hesabında eski bottan kalan açık emirleri ve pozisyonları elle kontrol et; asılı SL/TP emirlerini iptal et.
- [ ] Eski Supabase projesinde `risk_parameters.is_trading_enabled=false` yap, cron'ları kapat.
- [ ] Eski API anahtarlarını Binance'te sil; yeni bot için ayrı anahtar oluştur (yalnızca Futures izni, çekim kapalı, VPS IP'sine kısıtlı).

**Kapı:** hesapta bilinmeyen emir veya pozisyon yok.

## Faz 1: Stratejiyi kanıtla
- [x] Gelecek verisi sızdırmayan backtest (sonraki mumun açılışında giriş, high/low ile stop, komisyon + kayma + funding).
- [x] Aday strateji A: trend kırılımı (Donchian 20 + EMA 50/200 filtresi + ATR stop ve trailing stop).
- [ ] VPS'te 3+ yıllık veri indir: `npm run download -- --interval 4h --from 2021-01-01`.
- [ ] `npm run backtest -- --split 2025-01-01 --robustness` çalıştır, sonucu `PROGRESS.md`'ye yaz.
- [ ] Gerekirse aday B (1h pullback, 4h trend filtresi) ve C (ortalamaya dönüş) eklenir; her biri en fazla 5–6 parametre.

**Kapı (yalnızca out-of-sample):** ≥ 100 trade, Profit Factor ≥ 1,3, beklenen getiri ≥ 0,3R, maksimum düşüş ≤ %20, ±%20 parametre değişiminde sonuç çökmüyor. Hiçbir aday geçmezse **dur**; motoru canlıya almak para kaybettirir.

## Faz 2: Motor (kod hazır, doğrulama bekliyor)
- [x] Aynı strateji kodu backtest ve canlıda.
- [x] En fazla 8 gate (`src/risk/gates.ts`).
- [x] Stop mesafesinden pozisyon boyutu; likidasyon fiyatı stop'un ötesinde kalacak şekilde kaldıraç.
- [x] Deterministik client id (çift giriş yok), giriş sonrası anında reduce-only stop, stop konamazsa piyasadan kapat.
- [x] Her dakika mutabakat: borsada kapanan pozisyon kaydedilir, eksik stop yeniden konur, bilinmeyen pozisyonda kill switch.
- [x] Günlük zarar limiti, maksimum düşüşte otomatik kill switch, Telegram bildirimleri.
- [x] Paper modu (gerçek piyasa verisi, simüle hesap), Postgres, read-only API.
- [ ] Dashboard (React; API'yi okur). Eski projedeki uygun bileşenler taşınacak.

**Kapı:** testler geçiyor, testnet'te uçtan uca emir akışı doğrulandı (aşağıda).

## Faz 3: Testnet ve paper (4–8 hafta)
- [ ] Testnet'te doğrula: `BINANCE_STOP_API=algo` mı `legacy` mi çalışıyor; giriş, stop, trailing stop, stop tetiklenmesi, mutabakat.
- [ ] Ardından `MODE=paper` ile canlı veride çalıştır.
- [ ] Her hafta aynı dönemin backtest'ini çalıştırıp canlı sinyallerle karşılaştır.

**Kapı:** sinyaller backtest ile ≥ %90 örtüşüyor, veritabanı ile borsa arasında sıfır uyumsuzluk, en az 30 trade.

## Faz 4: Küçük sermayeyle canlı
- [ ] Kaybetmeyi göze alabileceğin tutar (ör. 200–500 USDT), `RISK_PER_TRADE=0.005`, `MAX_LEVERAGE=3`.
- [ ] İlk 2 hafta her gün Binance işlem geçmişi ile dashboard karşılaştırılır.
- [ ] Sermaye ancak 50+ canlı trade sonrası metrikler backtest bandındaysa artırılır.

## Kurallar
- Yeni gate yalnızca bir gate silinirse eklenir (en fazla 8).
- Strateji veya parametre değişikliği backtest'siz yapılmaz.
- Canlı sonuç kötü diye panikle parametre değiştirilmez; önce örneklem büyüklüğüne bakılır.
