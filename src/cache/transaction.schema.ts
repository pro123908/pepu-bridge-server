import { Schema, Prop, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TransactionDocument = Transaction & Document;

@Schema({ timestamps: true })
export class Transaction {
  @Prop({ required: true, unique: true, index: true })
  id: string;

  @Prop({ required: true })
  chain: string;

  @Prop({ required: true })
  type: string;

  @Prop({ required: true })
  user: string;

  @Prop()
  amount?: string;

  @Prop({ sparse: true, index: true })
  l1Token?: string;

  @Prop({ sparse: true, index: true })
  l2Token?: string;

  @Prop({ sparse: true, index: true })
  eventHash?: string;

  @Prop({ sparse: true, index: true })
  txHash?: string;

  @Prop({ required: true, default: 'PENDING' })
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';

  @Prop({ required: true })
  timestamp: number;

  @Prop({ default: () => new Date() })
  createdAt: Date;

  @Prop({ default: () => new Date() })
  updatedAt: Date;
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);
