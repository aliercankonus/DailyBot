# Hostinger VPS kurulumu

Ubuntu 22.04/24.04 bir Hostinger VPS varsayılır. Komutlar VPS'te çalıştırılır.

## 1. Sunucuyu hazırla (bir kez)

```bash
adduser trader && usermod -aG sudo trader
# Kendi bilgisayarından SSH anahtarını kopyala, sonra parola ile girişi kapat:
#   /etc/ssh/sshd_config -> PasswordAuthentication no, PermitRootLogin no
sudo systemctl restart ssh

sudo apt update && sudo apt -y upgrade
sudo apt -y install ufw fail2ban git
sudo ufw allow OpenSSH && sudo ufw enable

# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker trader   # yeniden giriş yap
```

Sunucu saati Binance imzalı istekleri için önemli: `timedatectl` çıktısında `System clock synchronized: yes` görünmeli.

## 2. Projeyi kur

```bash
git clone https://github.com/<kullanıcı>/<repo>.git trading-engine && cd trading-engine
cp .env.example .env
nano .env        # MODE=paper ile başla; POSTGRES_PASSWORD ve API_TOKEN (openssl rand -hex 32) doldur
docker compose up -d --build
docker compose logs -f engine
```

## 3. Veri indir ve backtest çalıştır (Faz 1)

```bash
docker compose run --rm engine node dist/cli/download.js --interval 4h --from 2021-01-01 --dir /tmp/data
```

Veriyi kalıcı tutmak için ayrı bir klasör bağla:

```bash
mkdir -p data && docker compose run --rm -v "$PWD/data:/app/data" -u root engine node dist/cli/download.js --interval 4h --from 2021-01-01
docker compose run --rm -v "$PWD/data:/app/data" engine node dist/cli/backtest.js --interval 4h --split 2025-01-01 --robustness
```

## 4. Testnet doğrulaması (Faz 3, canlıdan önce zorunlu)

1. Binance Futures testnet/demo hesabı aç, API anahtarı al.
2. `.env`: `MODE=testnet`, anahtarları gir, `BINANCE_STOP_API=algo`.
3. `docker compose up -d engine` ve loglarda şunları doğrula:
   - giriş emri dolar ve hemen bir stop emri görünür (Binance arayüzünde de kontrol et),
   - bir sonraki mum kapanışında trailing stop yenilenir, eski stop iptal olur,
   - stop tetiklendiğinde pozisyon veritabanında `CLOSED / EXCHANGE_CLOSE` olur.
4. Stop emri hata verirse (`STOP_FAILED` olayı) `BINANCE_STOP_API=legacy` ile tekrar dene. Hangisinin çalıştığını `PROGRESS.md`'ye yaz.

## 5. Dashboard / API erişimi

API yalnızca `127.0.0.1:8080`'de dinler. Dışarıdan erişim için:
- en güvenlisi SSH tüneli: `ssh -L 8080:localhost:8080 trader@VPS_IP`, sonra `curl -H "Authorization: Bearer $API_TOKEN" localhost:8080/status`;
- ya da Caddy/Nginx ile alan adı + TLS (port 443) üzerinden.

Acil durdurma:

```bash
curl -X POST -H "Authorization: Bearer $API_TOKEN" -H "content-type: application/json" \
  -d '{"on":true,"reason":"manuel"}' localhost:8080/kill-switch
```

Kill switch yeni girişleri durdurur; açık pozisyonların stopları borsada kalır ve yönetilmeye devam eder.

## 6. Bakım

- Güncelleme: `git pull && docker compose up -d --build`
- Yedek: `docker compose exec db pg_dump -U trader trader | gzip > backup-$(date +%F).sql.gz` (cron ile günlük)
- Loglar: `docker compose logs --since 1h engine`
