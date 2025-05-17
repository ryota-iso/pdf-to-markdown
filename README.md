# PDF to Markdown

PDFをMistral OCRを用いてMarkdownへ変換するCLIツール。 画像はR2(S3互換)へアップロードされる

## 環境構築

```zsh
# Denoのインストール
$ curl -fsSL https://deno.land/install.sh | sh

# 環境変数の準備
$ cp .env.sample .env

$ deno run --allow-read --allow-write --allow-net --allow-sys --allow-env --env=.env src/main.ts -i input.pdf -o output
```
