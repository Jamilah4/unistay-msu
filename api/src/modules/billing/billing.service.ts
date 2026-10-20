import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Invoice, InvoiceStatus, Payment } from './entities/invoice.entity';
import { CreateInvoiceDto, RecordPaymentDto } from './dto/billing.dto';
import { UsersService } from '../users/users.service';
import { HousingService } from '../housing/housing.service';
import { User } from '../users/entities/user.entity';
import { Role } from '../../common/enums/role.enum';

@Injectable()
export class BillingService {
  constructor(
    @InjectRepository(Invoice)
    private readonly invoiceRepo: Repository<Invoice>,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    private readonly usersService: UsersService,
    private readonly housingService: HousingService,
  ) {}

  async findAllInvoices(userId?: string): Promise<Invoice[]> {
    const qb = this.invoiceRepo.createQueryBuilder('invoice')
      .leftJoinAndSelect('invoice.tenant', 'tenant')
      .leftJoinAndSelect('invoice.property', 'property')
      .leftJoinAndSelect('invoice.unit', 'unit')
      .leftJoinAndSelect('invoice.payments', 'payments')
      .orderBy('invoice.dueDate', 'DESC')
      .addOrderBy('payments.paymentDate', 'DESC');

    if (userId) {
      qb.andWhere('tenant.id = :userId', { userId });
    }

    const invoices = await qb.getMany();
    return invoices.map((invoice) => this.refreshInvoiceStatus(invoice));
  }

  async findInvoiceById(id: string, tenantId?: string): Promise<Invoice> {
    const qb = this.invoiceRepo.createQueryBuilder('invoice')
      .leftJoinAndSelect('invoice.tenant', 'tenant')
      .leftJoinAndSelect('invoice.property', 'property')
      .leftJoinAndSelect('invoice.unit', 'unit')
      .leftJoinAndSelect('invoice.payments', 'payments')
      .where('invoice.id = :id', { id })
      .orderBy('payments.paymentDate', 'DESC');

    if (tenantId) {
      qb.andWhere('tenant.id = :tenantId', { tenantId });
    }

    const invoice = await qb.getOne();
    if (!invoice) {
      throw new NotFoundException(`Invoice with ID ${id} not found`);
    }
    return this.refreshInvoiceStatus(invoice);
  }

  private refreshInvoiceStatus(invoice: Invoice): Invoice {
    const totalAmount = Number(invoice.totalAmount);
    const paidAmount = Number(invoice.paidAmount);
    const dueDate = new Date(invoice.dueDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    dueDate.setHours(0, 0, 0, 0);

    if (totalAmount > 0 && paidAmount >= totalAmount) {
      invoice.status = InvoiceStatus.PAID;
    } else if (dueDate < today) {
      invoice.status = InvoiceStatus.OVERDUE;
    } else if (paidAmount > 0) {
      invoice.status = InvoiceStatus.PARTIALLY_PAID;
    } else {
      invoice.status = InvoiceStatus.UNPAID;
    }

    return invoice;
  }

  async createInvoice(dto: CreateInvoiceDto): Promise<Invoice> {
    const tenant = await this.usersService.findById(dto.tenantId);
    const property = await this.housingService.findPropertyById(dto.propertyId);
    const unit = dto.unitId
      ? property.units?.find((candidate) => candidate.id === dto.unitId)
      : undefined;
    if (dto.unitId && !unit) {
      throw new BadRequestException('The selected unit does not belong to the selected property');
    }

    const rent = Number(dto.rentAmount || 0);
    const electricity = Number(dto.electricityAmount || 0);
    const water = Number(dto.waterAmount || 0);
    const other = Number(dto.otherFees || 0);
    const totalAmount = rent + electricity + water + other;

    const invoiceNumber = `INV-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;

    const invoice = this.invoiceRepo.create({
      invoiceNumber,
      tenant,
      property,
      unit,
      rentAmount: rent,
      electricityAmount: electricity,
      waterAmount: water,
      otherFees: other,
      totalAmount,
      paidAmount: 0,
      dueDate: new Date(dto.dueDate),
      utilitySplitNotes: dto.utilitySplitNotes,
      status: InvoiceStatus.UNPAID,
    });

    return this.invoiceRepo.save(invoice);
  }

  async recordPayment(dto: RecordPaymentDto, recordedBy?: User): Promise<Payment> {
    const invoice = await this.findInvoiceById(
      dto.invoiceId,
      recordedBy?.role === Role.STUDENT ? recordedBy.id : undefined,
    );
    const outstandingBalance = Number(invoice.totalAmount) - Number(invoice.paidAmount);
    if (dto.amount <= 0 || dto.amount > outstandingBalance) {
      throw new BadRequestException('Payment amount must be greater than zero and no more than the outstanding balance');
    }

    const payment = this.paymentRepo.create({
      invoice,
      amount: dto.amount,
      paymentMethod: dto.paymentMethod,
      offlineReferenceId: dto.offlineReferenceId,
      receiptUrl: dto.receiptUrl,
      isSynced: true,
      recordedBy,
    });

    const paidAmount = Number(invoice.paidAmount) + Number(dto.amount);
    const status =
      paidAmount >= Number(invoice.totalAmount)
        ? InvoiceStatus.PAID
        : InvoiceStatus.PARTIALLY_PAID;

    return this.invoiceRepo.manager.transaction(async (manager) => {
      const savedPayment = await manager.getRepository(Payment).save(payment);
      await manager.getRepository(Invoice).update(invoice.id, { paidAmount, status });
      return savedPayment;
    });
  }
}
