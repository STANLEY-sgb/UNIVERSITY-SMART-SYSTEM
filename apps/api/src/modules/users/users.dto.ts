import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PageQuery } from '../../common/pagination';

export class CreateUserDto {
  @ApiProperty() @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) displayName!: string;
  @ApiProperty({ description: 'Initial password; the user must change it at first sign-in.' })
  @IsString() @MaxLength(128) password!: string;
  @ApiProperty({ type: [String], example: ['SECURITY_OFFICER'] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5) @IsString({ each: true }) roleCodes!: string[];
}

export class UpdateUserDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) displayName?: string;
  @ApiPropertyOptional({ enum: ['ACTIVE', 'SUSPENDED', 'DISABLED'] })
  @IsOptional() @IsEnum({ ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED', DISABLED: 'DISABLED' }) status?: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5) @IsString({ each: true }) roleCodes?: string[];
  @ApiPropertyOptional({ description: 'Required when changing roles or status.' })
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class ListUsersQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) role?: string;
  @ApiPropertyOptional({ enum: ['STAFF', 'STUDENT'] })
  @IsOptional() @IsEnum({ STAFF: 'STAFF', STUDENT: 'STUDENT' }) @Type(() => String) userType?: 'STAFF' | 'STUDENT';
}
