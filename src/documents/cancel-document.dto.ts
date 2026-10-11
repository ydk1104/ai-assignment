import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class CancelDocumentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  userId!: string;

  /** 취소할 생성 요청(POST /create_document)에 썼던 Idempotency-Key */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  idempotencyKey!: string;
}
