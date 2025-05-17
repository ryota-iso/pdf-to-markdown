// 型定義
export type AppError =
  | ValidationError
  | NotFoundError
  | SystemError;

// 基本エラークラス
export class BaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

// 各種エラークラス
export class ValidationError extends BaseError {
  constructor(message: string) {
    super(`バリデーションエラー: ${message}`);
  }
}

export class NotFoundError extends BaseError {
  constructor(entityName: string, id: string) {
    super(`${entityName}(ID: ${id})が見つかりません`);
  }
}

export class SystemError extends BaseError {
  constructor(message: string) {
    super(`システムエラー: ${message}`);
  }
}
