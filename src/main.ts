import { err, ok, Result, ResultAsync } from "npm:neverthrow";
import { AppError, SystemError, ValidationError } from "./result.ts";
import { parseArgs } from "node:util";
import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";
import { basename, join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { Mistral } from "npm:@mistralai/mistralai";
import { PutObjectCommand, S3Client } from "npm:@aws-sdk/client-s3";
import { decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

type Args = {
  input: string;
  outDir: string;
};

const getCliArgs = async (): Promise<Result<Args, AppError>> => {
  const { values: { input, outDir } } = parseArgs({
    args: Deno.args,
    options: {
      input: { type: "string", short: "i" },
      outDir: { type: "string", short: "o" },
    },
    allowPositionals: false,
  });
  if (!input) return err(new ValidationError("args.input が見つかりません"));
  if (!outDir) return err(new ValidationError("args.outDir が見つかりません"));

  try {
    const statIn = await Deno.statSync(input);
    if (!statIn.isFile) return err(new ValidationError("args.input はファイルではありません"));
  } catch {
    return err(new ValidationError("args.input が存在しません"));
  }
  try {
    const statOut = await Deno.statSync(outDir);
    if (!statOut.isDirectory) return err(new ValidationError("args.outDir はディレクトリではありません"));
  } catch {
    return err(new ValidationError("args.outDir が存在しません"));
  }

  return ok({ input, outDir });
};

type Env = {
  MISTRAL_OCR_API_KEY: string;
  R2_S3_URL: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
  R2_PUBLIC_URL: string;
};

const getEnvs = (): Result<Env, AppError> => {
  const MISTRAL_OCR_API_KEY = Deno.env.get("MISTRAL_OCR_API_KEY");
  const R2_S3_URL = Deno.env.get("R2_S3_URL");
  const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID");
  const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY");
  const R2_BUCKET_NAME = Deno.env.get("R2_BUCKET_NAME");
  const R2_PUBLIC_URL = Deno.env.get("R2_PUBLIC_URL");
  if (!MISTRAL_OCR_API_KEY) return err(new ValidationError("MISTRAL_OCR_API_KEY が見つかりません"));
  if (!R2_S3_URL) return err(new ValidationError("R2_S3_URL が見つかりません"));
  if (!R2_ACCESS_KEY_ID) return err(new ValidationError("R2_ACCESS_KEY_ID が見つかりません"));
  if (!R2_SECRET_ACCESS_KEY) return err(new ValidationError("R2_SECRET_ACCESS_KEY が見つかりません"));
  if (!R2_BUCKET_NAME) return err(new ValidationError("R2_BUCKET_NAME が見つかりません"));
  if (!R2_PUBLIC_URL) return err(new ValidationError("R2_PUBLIC_URL が見つかりません"));
  return ok({ MISTRAL_OCR_API_KEY, R2_S3_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL });
};

type OCRPageObject = {
  index: number;
  markdown: string;
  images: {
    id: string;
    imageBase64?: string | null;
    bottomRightX: number | null;
    bottomRightY: number | null;
    topLeftX: number | null;
    topLeftY: number | null;
  }[];
  dimensions: { dpi?: number; height?: number; width?: number } | null;
};

const processOcr = (args: { apiKey: string; pdfPath: string }): ResultAsync<OCRPageObject[], AppError> => {
  return ResultAsync.fromPromise(
    (async () => {
      const { apiKey, pdfPath } = args;
      const client = new Mistral({ apiKey });

      const pdfBytes = await Deno.readFile(pdfPath);
      const file = new File([pdfBytes], basename(pdfPath), { type: "application/pdf" });
      const uploaded = await client.files.upload({ file, purpose: "ocr" });
      const signed = await client.files.getSignedUrl({ fileId: uploaded.id });

      const result = await client.ocr.process({
        model: "mistral-ocr-latest",
        document: { type: "document_url", documentUrl: signed.url },
        includeImageBase64: true,
      });
      return result.pages;
    })(),
    (_err) => new SystemError(`OCR 処理に失敗しました`),
  );
};

type ImageMap = {
  id: string;
  url: string;
}[];

export const uploadImages = (
  args: {
    bucketName: string;
    s3Url: string;
    accessKeyId: string;
    secretAccessKey: string;
    publicUrl: string;
    images: OCRPageObject["images"][number][];
  },
): ResultAsync<ImageMap, SystemError> => {
  const { bucketName, s3Url, accessKeyId, secretAccessKey, publicUrl, images } = args;

  const client = new S3Client({
    region: "auto",
    endpoint: s3Url,
    credentials: { accessKeyId, secretAccessKey },
  });

  return ResultAsync.fromPromise(
    (async () => {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, "0");
      const dd = String(today.getDate()).padStart(2, "0");
      const ymd = `${yyyy}-${mm}-${dd}`;
      const uploaded: ImageMap = [];
      for (const { id, imageBase64 } of images) {
        if (!imageBase64) continue;
        const base64 = imageBase64.replace(/^data:image\/\w+;base64,/, "").replace(/\s+/g, "");
        const body = decodeBase64(base64);
        const key = `paper/${ymd}/${id}.png`;
        await client.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: body,
            ContentType: "image/png",
            ACL: "public-read",
          }),
        );
        uploaded.push({ id, url: `${publicUrl}/${key}` });
      }
      return uploaded;
    })(),
    (e) => new SystemError(`画像のアップロードに失敗しました: ${e}`),
  );
};

const generateMarkdown = (args: { objects: OCRPageObject[]; images: ImageMap; outDir: string }): ResultAsync<void, AppError> => {
  const { objects, images, outDir } = args;
  return ResultAsync.fromPromise(
    (async () => {
      const combinedLines: string[] = [];
      for (const object of objects) {
        const lines: string[] = [];
        lines.push(`# Page ${object.index + 1}`);
        lines.push("");
        lines.push(object.markdown);
        lines.push("");
        for (const img of object.images) {
          const uploaded = images.find((u) => u.id === img.id);
          if (!uploaded) continue;
          lines.push(`![${img.id}](${uploaded.url})`);
          lines.push("");
        }
        const filePath = join(outDir, `page-${object.index + 1}.md`);
        await Deno.writeTextFile(filePath, lines.join("\n"));
        combinedLines.push(...lines, "");
      }
      const combinedPath = join(outDir, "all-pages.md");
      await Deno.writeTextFile(combinedPath, combinedLines.join("\n"));
    })(),
    (e) => new SystemError(`マークダウンの生成に失敗しました: ${e}`),
  );
};

const main = async (): Promise<Result<void, AppError>> => {
  // コマンドライン引数の取得
  const cli = await getCliArgs();
  if (cli.isErr()) return err(cli.error);
  const { input, outDir } = cli.value;

  // 環境変数の取得
  const envs = getEnvs();
  if (envs.isErr()) return err(envs.error);
  const { MISTRAL_OCR_API_KEY, R2_S3_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL } = envs.value;

  // 出力用ディレクトリの作成
  const dirResult = await ResultAsync.fromPromise(
    ensureDir(outDir),
    (_err) => new SystemError("ディレクトリの作成に失敗しました"),
  );
  if (dirResult.isErr()) return err(dirResult.error);

  // MistralによるOCR
  const ocrResult = await processOcr({ apiKey: MISTRAL_OCR_API_KEY, pdfPath: input });
  if (ocrResult.isErr()) return err(ocrResult.error);
  const ocrPageObject = ocrResult.value;

  // 画像抽出とR2へのアップロード
  const imageUploadResult = await uploadImages({
    bucketName: R2_BUCKET_NAME,
    s3Url: R2_S3_URL,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    publicUrl: R2_PUBLIC_URL,
    images: ocrPageObject.flatMap((object) => object.images),
  });
  if (imageUploadResult.isErr()) return err(imageUploadResult.error);
  const imageMap = imageUploadResult.value;

  // マークダウンの生成
  const mdResult = await generateMarkdown({ objects: ocrPageObject, images: imageMap, outDir });
  if (mdResult.isErr()) return err(mdResult.error);

  return ok();
};

if (import.meta.main) {
  const result = await main();
  result.match(
    () => {},
    (err) => {
      console.error(err);
      Deno.exit(1);
    },
  );
}
