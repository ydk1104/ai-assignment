import {
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class CreateDocumentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  userId!: string;

  @IsString()
  @IsNotEmpty()
  prompt!: string;

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  maxTokens!: number;
}
