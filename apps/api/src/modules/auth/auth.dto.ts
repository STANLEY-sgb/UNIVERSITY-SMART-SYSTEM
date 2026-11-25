import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'security@kiu-demo.test' })
  @IsEmail() @MaxLength(254)
  email!: string;

  @ApiProperty() @IsString() @MinLength(1) @MaxLength(128)
  password!: string;

  @ApiPropertyOptional({ description: '6-digit TOTP or a single-use recovery code' })
  @IsOptional() @IsString() @MaxLength(32)
  mfaCode?: string;
}

export class RefreshDto {
  @ApiPropertyOptional({ description: 'Only for non-browser clients; browsers use the HttpOnly cookie.' })
  @IsOptional() @IsString() @MaxLength(256)
  refreshToken?: string;
}

export class RegisterStudentDto {
  @ApiProperty({ example: '2023-BCS-001', description: 'Registration number as issued by Registry.' })
  @IsString() @MinLength(3) @MaxLength(40)
  regNo!: string;

  @ApiProperty({ example: 'student01@kiu-demo.test' })
  @IsEmail() @MaxLength(254)
  email!: string;

  @ApiProperty({ description: 'At least 12 characters.' })
  @IsString() @MaxLength(128)
  password!: string;
}

export class ForgotPasswordDto {
  @ApiProperty() @IsEmail() @MaxLength(254)
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty() @IsString() @MinLength(20) @MaxLength(256)
  token!: string;

  @ApiProperty() @IsString() @MaxLength(128)
  newPassword!: string;
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() @MaxLength(128)
  currentPassword!: string;

  @ApiProperty() @IsString() @MaxLength(128)
  newPassword!: string;
}

export class MfaEnableDto {
  @ApiProperty({ example: '123456' }) @IsString() @MinLength(6) @MaxLength(8)
  code!: string;
}
