import { maskDigits, maskEmployee, maskHolderName } from './masking';
import type { EmployeeRow } from './employee.types';

describe('BR-EMP-003 masking (§4.3)', () => {
  describe('digit fields', () => {
    it('keeps exactly the last four characters', () => {
      expect(maskDigits('3201234567890001')).toBe('••••••••••••0001');
    });

    it('leaves the length readable, which is what makes the mask verifiable', () => {
      expect(maskDigits('3201234567890001')).toHaveLength(16);
    });

    it('reveals nothing at all when the value is four characters or shorter', () => {
      // The rule is "all but the last 4"; applied naively to a 3-character value
      // it would show the whole thing. A short value is fully masked instead.
      expect(maskDigits('1234')).toBe('••••');
      expect(maskDigits('12')).toBe('••');
    });

    it('passes null through as null — absent is not the same as hidden', () => {
      expect(maskDigits(null)).toBeNull();
    });
  });

  describe('holder names', () => {
    it('keeps the first word so the owner can recognise their own account', () => {
      expect(maskHolderName('SARI DEWI LESTARI')).toBe('SARI •••• •••••••');
    });

    it('leaves a single-word name whole', () => {
      expect(maskHolderName('SUKARNO')).toBe('SUKARNO');
    });

    it('passes null through', () => {
      expect(maskHolderName(null)).toBeNull();
    });
  });

  const row: EmployeeRow = {
    id: 'e1',
    companyId: 'c1',
    userId: null,
    employeeNumber: 'E-001',
    fullName: 'Sari Dewi',
    joinDate: '2026-01-01',
    employmentType: 'pkwtt',
    status: 'active',
    nik: '3201234567890001',
    npwp: '098765432109000',
    bpjsKesehatanNumber: '0001234567890',
    bpjsKetenagakerjaanNumber: null,
    bankName: 'BCA',
    bankAccountNumber: '1234567890',
    bankAccountHolder: 'SARI DEWI',
    birthPlace: 'Bandung',
    birthDate: '1990-05-04',
    gender: 'female',
    maritalStatus: 'single',
    religion: 'islam',
    ptkpStatus: 'tk_0',
    address: 'Jl. Merdeka 1',
    phone: '+628123456789',
    personalEmail: 'sari@example.test',
    updatedAt: new Date('2026-08-06T00:00:00Z'),
  };

  it('masks every member of the encrypted set on a detail read', () => {
    const masked = maskEmployee(row);
    expect(masked.nik).toBe('••••••••••••0001');
    expect(masked.npwp).toBe('•••••••••••9000');
    expect(masked.bpjsKesehatanNumber).toBe('•••••••••7890');
    expect(masked.bankAccountNumber).toBe('••••••7890');
    expect(masked.bankAccountHolder).toBe('SARI ••••');
  });

  it('leaves the plaintext class untouched — those are RBAC-gated, not encrypted', () => {
    // ADR-0016 decision 1 excluded PTKP, birth date, address and phone from the
    // encrypted set on purpose; masking them here would imply a protection the
    // storage layer does not provide.
    const masked = maskEmployee(row);
    expect(masked.ptkpStatus).toBe('tk_0');
    expect(masked.birthDate).toBe('1990-05-04');
    expect(masked.address).toBe('Jl. Merdeka 1');
    expect(masked.phone).toBe('+628123456789');
    expect(masked.bankName).toBe('BCA');
  });
});
