import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PageQuery } from '../../common/pagination';

const STATUSES = { ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED', WITHDRAWN: 'WITHDRAWN', GRADUATED: 'GRADUATED' } as const;
type StudentStatusValue = keyof typeof STATUSES;

export class CreateStudentDto {
  @ApiProperty({ example: '2026-BSC-0001' })
  @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9/_-]{3,31}$/, { message: 'regNo must be 4-32 chars: letters, digits, / _ -' })
  regNo!: string;

  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) fullName!: string;
  @ApiProperty() @IsUUID() programmeId!: string;
  @ApiProperty({ minimum: 1, maximum: 7 }) @Type(() => Number) @IsInt() @Min(1) @Max(7) yearOfStudy!: number;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) phone?: string;
}

export class UpdateStudentStatusDto {
  @ApiProperty({ enum: Object.keys(STATUSES) })
  @IsEnum(STATUSES) accountStatus!: StudentStatusValue;

  @ApiProperty({ description: 'Mandatory justification, stored in the audit trail.' })
  @IsString() @MinLength(5) @MaxLength(300) reason!: string;
}

export class ListStudentsQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'Matches registration number or name' })
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() programmeId?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(7) yearOfStudy?: number;
  @ApiPropertyOptional({ enum: Object.keys(STATUSES) })
  @IsOptional() @IsEnum(STATUSES) accountStatus?: StudentStatusValue;
}
