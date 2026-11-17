# Eski sistemin (dailytradingbot) incelemesi

Bu proje, `aliercankonus/dailytradingbot` (Lovable + Supabase) incelendikten sonra sıfırdan yazıldı. Aşağıdaki her madde yeni kodda nasıl çözüldüğüyle birlikte listelenmiştir.

| # | Eski sistemdeki sorun | Kanıt (eski repo) | Yeni sistemdeki çözüm |
|---|---|---|---|
| 1 | Aşırı filtre: 189 açma/kapama ayarı, ~30 gate + `execute-trade`'de 75 ek red noktası, 24 istisna tipi. Sinyal neredeyse hiç geçmiyordu. | `_shared/constants.ts` (9.583 satır), `strategy-analyzer/index.ts` | En fazla 8 gate, tek dosya (`src/risk/gates.ts`). İstisna/bypass yok. |
| 2 | Spot API'ye SHORT emri: elde coin yoksa hata, varsa eldeki coini satıyordu. | `execute-trade/index.ts:594`, `:2052` | Futures API, one-way mode; short gerçek short. |
| 3 | SL ve TP aynı miktar için iki ayrı spot emri; ikincisi bakiye yetersizliğinden reddediliyordu. | `execute-trade/index.ts:2412`, `:2440` | Tek reduce-only STOP_MARKET (mark price ile tetiklenir). Trailing stop: önce yenisi konur, sonra eskisi iptal edilir. |
| 4 | Kapatmalar Binance'e emir göndermiyordu; uygulama "kapandı" derken coin hesapta kalıyordu. | Binance'e emir gönderen tek dosya `execute-trade` | Her kapanış gerçek emir. Her dakika mutabakat; borsa tek doğruluk kaynağı. |
| 5 | Stop konamazsa pozisyon korumasız kalıyor, sadece bildirim gidiyordu. | `execute-trade/index.ts:2425` | `protectOrClose()`: stop konamazsa piyasadan kapat; o da olmazsa kill switch. |
| 6 | Backtest gelecek veriyi kullanıyordu (kapanmamış 4h mumu). | `backtest-runner/index.ts:923-931` | Strateji yalnızca kapanmış mumları görür; giriş sonraki mumun açılışında. Testle korunuyor. |
| 7 | Backtest çıkışları yalnızca kapanış fiyatına göre; stoplar yanlış ölçülüyordu. | `backtest-runner/index.ts:938`, `:969` | High/low ile stop; boşlukta açılış fiyatından dolum. |
| 8 | Backtest ile canlı farklı kod çalıştırıyordu. | `execute-trade`'deki 75 ek filtre backtest'te yok | Aynı `Strategy` nesnesi ve aynı `sizePosition()` her iki tarafta. |
| 9 | 10–20 trade sonra sembol/strateji otomatik kapatılıyordu (istatistiksel gürültü); "yarım kazanç" kazanma oranını şişiriyordu. | `strategy-analyzer` performans filtreleri | Yok. Değerlendirme beklenen getiri (R) ve Profit Factor ile, yeterli örneklemle, out-of-sample. |
| 10 | Yetki açığı: herhangi bir `Authorization` başlığı bot döngüsünü tetikleyebiliyordu; çakışma kilidi kontrol edilmiyordu. | `auto-trader/index.ts:58-64`, `:88` | Motor dışarıya açık değil; API sabit-zamanlı token karşılaştırması; Postgres advisory lock ile tek motor örneği. |
| 11 | Çift emir riski: tekrar denemelerde aynı emir iki kez girilebiliyordu. | `execute-trade` retry döngüsü | Deterministik `newClientOrderId`; zaman aşımında önce emir sorgulanır. |
| 12 | Futures'a geçişte likidasyon riski hesaba katılmamıştı (spot'ta yoktu). | — | Kaldıraç, likidasyon mesafesi stop mesafesinin en az 2 katı olacak şekilde seçilir. |
