# Reels com reação

Aplicação web local que cria vídeos verticais com uma reação sobreposta.

## Funcionalidades

- Criação de um banco local de reações a partir de vídeos do usuário.
- Compactação de vídeo e remoção de fundo com MODNet/ONNX.
- Análise visual com a API da OpenAI para identificar e nomear reações.
- Análise de um Reels para escolher a reação mais adequada.
- Posicionamento arrastável da reação.
- Saída MP4 vertical 9:16 em 720 × 1280, otimizada para processamento em nuvem.
- Áudio original do Reels preservado; reação sem áudio.
- Troca manual da reação e nova geração do vídeo.
- Armazenamento local em SQLite e no sistema de arquivos.
- Preview fiel ao resultado final, com posição e tamanho ajustáveis.

## Requisitos

- Node.js 22.13 ou superior
- Python 3.11 ou superior
- FFmpeg e FFprobe disponíveis no `PATH`
- Uma chave da API da OpenAI

## Instalação

```bash
npm install
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env.local
```

Preencha `OPENAI_API_KEY` em `.env.local` e execute:

```bash
npm run dev
```

Abra [http://localhost:3000](http://localhost:3000).

## Railway

O projeto inclui uma imagem Docker com Node.js, Python, FFmpeg e o modelo de
remoção de fundo. No Railway, configure `OPENAI_API_KEY` e anexe um volume
persistente em `/data`. O navegador e a API são publicados no mesmo domínio.

## Dados locais

Vídeos, resultados e o banco SQLite ficam em `data/`. Esse diretório, a chave
da API e o ambiente Python não são enviados ao GitHub.

## Testes

```bash
npm test
```
