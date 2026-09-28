/**
 * The default template set, in Uzbek, Russian and English.
 *
 * These rows are what `prisma/seed` inserts for a new organisation, and what
 * `./dispatch.ts` falls back to when an organisation has no row for an event --
 * a school that has never opened the templates screen still sends real messages
 * rather than an empty body.
 *
 * The placeholder grammar is the one `./template.ts` actually implements:
 * `{{variable}}`, `{{object.path}}` and `{{#if variable}}...{{/if}}`. There is no
 * `{{#each}}`, no `{{else}}` and no formatting helper, which is why a boolean
 * like `passed` appears as an additive `{{#if}}` clause rather than an
 * either/or -- the affirmative case adds a sentence, and the neutral text has to
 * read correctly on its own.
 *
 * WHY ONLY IN_APP, SMS AND EMAIL. Telegram and push have no address column in
 * the schema (see UNADDRESSABLE_CHANNELS in ./recipients.ts), and WhatsApp
 * business messaging requires templates registered and approved inside Meta's
 * console -- text seeded here would not be the text that ships. Seeding rows for
 * those channels would promise delivery the platform cannot perform.
 *
 * SMS IS BILLED PER SEGMENT. 160 characters for GSM-alphabet text, 70 for
 * anything with Cyrillic in it, so the Russian SMS bodies are deliberately
 * clipped: a sentence of politeness added here is an invoice line multiplied by
 * every guardian in the school. The email bodies carry the courtesy instead.
 *
 * Every body below is checked against its event's zod schema at module load, so
 * a template cannot reference a variable the event does not supply.
 */

import type { Locale, NotificationChannel, NotificationEvent } from '@/generated/prisma/client';
import { NOTIFICATION_EVENT_KEYS, NOTIFICATION_EVENTS, eventVariableNames } from './events';
import { validateTemplate } from './template';

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

interface LocalisedCopy {
  /** Email subject and in-app heading. SMS has no subject line. */
  readonly title: string;
  /** One or two sentences. Kept short because segments cost money. */
  readonly sms: string;
  /** The statement of fact, in full. Also the middle of the email body. */
  readonly inApp: string;
  /** An extra block the email can afford and a notification badge cannot. */
  readonly emailDetail?: string;
}

type EventCopy = Readonly<Record<Locale, LocalisedCopy>>;

/**
 * Greeting and footer wrapped around `inApp` to build the email body.
 *
 * The footer says the message is automatic rather than signing off as a person,
 * because the same envelope serves a parent reading an absence notice and an
 * accountant reading a discount approval request -- "Hurmat bilan, ma'muriyat"
 * would be wrong on the second.
 */
const EMAIL_ENVELOPE: Readonly<Record<Locale, { greeting: string; footer: string }>> = {
  UZ: {
    greeting: 'Assalomu alaykum!',
    footer: "Bu xabar o'quv markaz boshqaruv tizimi tomonidan avtomatik yuborilgan.",
  },
  RU: {
    greeting: 'Здравствуйте!',
    footer: 'Это письмо отправлено автоматически системой управления учебным центром.',
  },
  EN: {
    greeting: 'Hello,',
    footer: 'This message was sent automatically by the school management system.',
  },
};

/**
 * One entry per NotificationEvent. `satisfies Record<NotificationEvent, ...>`
 * means adding an event to the enum without writing its copy fails to compile,
 * which is the only way a new event cannot quietly ship with a blank body.
 */
export const NOTIFICATION_TEMPLATE_COPY = {
  // --- Attendance ---------------------------------------------------------
  STUDENT_ABSENT: {
    UZ: {
      title: 'Farzandingiz darsga kelmadi',
      sms: '{{studentName}} {{lessonDate}} {{lessonTime}} {{groupName}} darsiga kelmadi.',
      inApp:
        "{{studentName}} {{groupName}} guruhining {{lessonDate}} kuni soat {{lessonTime}} da bo'lgan darsiga kelmadi.",
      emailDetail:
        "Sabab ma'lum bo'lsa, iltimos, o'quv markazga xabar bering -- davomat yozuvi tuzatiladi.",
    },
    RU: {
      title: 'Пропуск занятия',
      sms: '{{studentName}} не был(а) на занятии {{groupName}} {{lessonDate}} в {{lessonTime}}.',
      inApp:
        '{{studentName}} отсутствовал(а) на занятии группы {{groupName}} {{lessonDate}} в {{lessonTime}}.',
      emailDetail:
        'Если причина известна, сообщите, пожалуйста, администрации -- запись о посещаемости будет исправлена.',
    },
    EN: {
      title: 'Absence recorded',
      sms: '{{studentName}} missed the {{groupName}} lesson on {{lessonDate}} at {{lessonTime}}.',
      inApp:
        '{{studentName}} was absent from the {{groupName}} lesson on {{lessonDate}} at {{lessonTime}}.',
      emailDetail:
        'If you know the reason, please tell the office and the attendance record will be corrected.',
    },
  },

  STUDENT_LATE: {
    UZ: {
      title: 'Darsga kech qoldi',
      sms: '{{studentName}} {{groupName}} darsiga {{minutesLate}} daqiqa kech keldi ({{lessonDate}}).',
      inApp:
        '{{studentName}} {{lessonDate}} kuni soat {{lessonTime}} dagi {{groupName}} darsiga {{minutesLate}} daqiqa kech keldi.',
    },
    RU: {
      title: 'Опоздание на занятие',
      sms: '{{studentName}} опоздал(а) на {{minutesLate}} мин. на занятие {{groupName}} {{lessonDate}}.',
      inApp:
        '{{studentName}} опоздал(а) на {{minutesLate}} мин. на занятие группы {{groupName}} {{lessonDate}} в {{lessonTime}}.',
    },
    EN: {
      title: 'Late arrival',
      sms: '{{studentName}} arrived {{minutesLate}} min late for {{groupName}} on {{lessonDate}}.',
      inApp:
        '{{studentName}} arrived {{minutesLate}} minutes late for the {{groupName}} lesson on {{lessonDate}} at {{lessonTime}}.',
    },
  },

  ATTENDANCE_SUBMITTED: {
    UZ: {
      title: 'Davomat topshirildi',
      sms: '{{groupName}} {{lessonDate}}: keldi {{presentCount}}, kelmadi {{absentCount}}.',
      inApp:
        '{{teacherName}} {{groupName}} guruhining {{lessonDate}} kunidagi davomatini topshirdi: {{presentCount}} keldi, {{absentCount}} kelmadi.',
    },
    RU: {
      title: 'Журнал посещаемости сдан',
      sms: '{{groupName}} {{lessonDate}}: присут. {{presentCount}}, отсут. {{absentCount}}.',
      inApp:
        '{{teacherName}} сдал(а) журнал группы {{groupName}} за {{lessonDate}}: присутствовали {{presentCount}}, отсутствовали {{absentCount}}.',
    },
    EN: {
      title: 'Register submitted',
      sms: '{{groupName}} {{lessonDate}}: {{presentCount}} present, {{absentCount}} absent.',
      inApp:
        '{{teacherName}} submitted the {{groupName}} register for {{lessonDate}}: {{presentCount}} present, {{absentCount}} absent.',
    },
  },

  ATTENDANCE_CORRECTED: {
    UZ: {
      title: 'Davomat tuzatildi',
      sms: '{{studentName}} ({{lessonDate}}): {{previousStatus}} -> {{newStatus}}. {{correctedBy}}.',
      inApp:
        "{{correctedBy}} {{studentName}} ning {{groupName}} guruhidagi {{lessonDate}} kunlik davomatini o'zgartirdi: {{previousStatus}} -> {{newStatus}}.{{#if reason}} Sabab: {{reason}}{{/if}}",
    },
    RU: {
      title: 'Посещаемость исправлена',
      sms: '{{studentName}} ({{lessonDate}}): {{previousStatus}} -> {{newStatus}}. {{correctedBy}}.',
      inApp:
        '{{correctedBy}} изменил(а) посещаемость {{studentName}} в группе {{groupName}} за {{lessonDate}}: {{previousStatus}} -> {{newStatus}}.{{#if reason}} Причина: {{reason}}{{/if}}',
    },
    EN: {
      title: 'Attendance corrected',
      sms: '{{studentName}} ({{lessonDate}}): {{previousStatus}} -> {{newStatus}} by {{correctedBy}}.',
      inApp:
        '{{correctedBy}} changed the attendance of {{studentName}} for {{groupName}} on {{lessonDate}}: {{previousStatus}} -> {{newStatus}}.{{#if reason}} Reason: {{reason}}{{/if}}',
    },
  },

  DAILY_ATTENDANCE_SUMMARY: {
    UZ: {
      title: 'Kunlik davomat hisoboti',
      sms: '{{branchName}} {{date}}: {{presentCount}} keldi, {{lateCount}} kech, {{absentCount}} kelmadi ({{attendancePercent}}).',
      inApp:
        '{{branchName}} filiali, {{date}}: {{presentCount}} keldi, {{lateCount}} kech qoldi, {{absentCount}} kelmadi. Umumiy davomat: {{attendancePercent}}.',
    },
    RU: {
      title: 'Сводка посещаемости за день',
      sms: '{{branchName}} {{date}}: {{presentCount}} присут., {{lateCount}} опозд., {{absentCount}} отсут. ({{attendancePercent}}).',
      inApp:
        'Филиал {{branchName}}, {{date}}: присутствовали {{presentCount}}, опоздали {{lateCount}}, отсутствовали {{absentCount}}. Посещаемость: {{attendancePercent}}.',
    },
    EN: {
      title: 'Daily attendance summary',
      sms: '{{branchName}} {{date}}: {{presentCount}} present, {{lateCount}} late, {{absentCount}} absent ({{attendancePercent}}).',
      inApp:
        '{{branchName}} on {{date}}: {{presentCount}} present, {{lateCount}} late, {{absentCount}} absent. Attendance: {{attendancePercent}}.',
    },
  },

  // --- Finance ------------------------------------------------------------
  INVOICE_ISSUED: {
    UZ: {
      title: "Yangi to'lov hisobi",
      sms: "{{studentName}}: {{invoiceNumber}} hisobi {{amount}}. Muddat {{dueDate}}.",
      inApp:
        "{{studentName}} uchun {{invoiceNumber}} raqamli hisob shakllantirildi. Summa: {{amount}}, to'lov muddati: {{dueDate}}.",
      emailDetail:
        "Hisob raqami: {{invoiceNumber}}\nSumma: {{amount}}\nTo'lov muddati: {{dueDate}}",
    },
    RU: {
      title: 'Выставлен счёт',
      sms: 'Счёт {{invoiceNumber}} для {{studentName}}: {{amount}}. Срок {{dueDate}}.',
      inApp:
        'Для {{studentName}} выставлен счёт {{invoiceNumber}}. Сумма: {{amount}}, оплатить до {{dueDate}}.',
      emailDetail: 'Номер счёта: {{invoiceNumber}}\nСумма: {{amount}}\nСрок оплаты: {{dueDate}}',
    },
    EN: {
      title: 'Invoice issued',
      sms: 'Invoice {{invoiceNumber}} for {{studentName}}: {{amount}}. Due {{dueDate}}.',
      inApp:
        'Invoice {{invoiceNumber}} has been issued for {{studentName}}. Amount: {{amount}}, due {{dueDate}}.',
      emailDetail: 'Invoice number: {{invoiceNumber}}\nAmount: {{amount}}\nDue date: {{dueDate}}',
    },
  },

  PAYMENT_RECEIVED: {
    UZ: {
      title: "To'lov qabul qilindi",
      sms: "{{amount}} to'lov qabul qilindi. Kvitansiya {{receiptNumber}}.{{#if remainingBalance}} Qoldiq {{remainingBalance}}.{{/if}}",
      inApp:
        "{{paidOn}} kuni {{studentName}} uchun {{amount}} to'lov qabul qilindi. Kvitansiya: {{receiptNumber}}.{{#if remainingBalance}} Qolgan qarz: {{remainingBalance}}.{{/if}}",
      emailDetail:
        "Kvitansiya: {{receiptNumber}}\nSumma: {{amount}}\nSana: {{paidOn}}{{#if remainingBalance}}\nQolgan qarz: {{remainingBalance}}{{/if}}",
    },
    RU: {
      title: 'Платёж принят',
      sms: 'Платёж {{amount}} принят. Квитанция {{receiptNumber}}.{{#if remainingBalance}} Остаток {{remainingBalance}}.{{/if}}',
      inApp:
        '{{paidOn}} принят платёж {{amount}} за {{studentName}}. Квитанция: {{receiptNumber}}.{{#if remainingBalance}} Остаток задолженности: {{remainingBalance}}.{{/if}}',
      emailDetail:
        'Квитанция: {{receiptNumber}}\nСумма: {{amount}}\nДата: {{paidOn}}{{#if remainingBalance}}\nОстаток: {{remainingBalance}}{{/if}}',
    },
    EN: {
      title: 'Payment received',
      sms: 'Payment of {{amount}} received. Receipt {{receiptNumber}}.{{#if remainingBalance}} Balance {{remainingBalance}}.{{/if}}',
      inApp:
        'A payment of {{amount}} for {{studentName}} was recorded on {{paidOn}}. Receipt: {{receiptNumber}}.{{#if remainingBalance}} Remaining balance: {{remainingBalance}}.{{/if}}',
      emailDetail:
        'Receipt: {{receiptNumber}}\nAmount: {{amount}}\nDate: {{paidOn}}{{#if remainingBalance}}\nRemaining balance: {{remainingBalance}}{{/if}}',
    },
  },

  PAYMENT_REMINDER: {
    UZ: {
      title: "To'lov muddati yaqinlashdi",
      sms: "{{invoiceNumber}} hisobi {{amount}}, {{dueDate}} gacha. {{daysUntilDue}} kun qoldi.",
      inApp:
        "{{studentName}} uchun {{invoiceNumber}} hisobining to'lov muddati {{dueDate}} -- {{daysUntilDue}} kun qoldi. Summa: {{amount}}.",
    },
    RU: {
      title: 'Напоминание об оплате',
      sms: 'Счёт {{invoiceNumber}} на {{amount}} — до {{dueDate}}, осталось {{daysUntilDue}} дн.',
      inApp:
        'Счёт {{invoiceNumber}} за {{studentName}} нужно оплатить до {{dueDate}} -- осталось {{daysUntilDue}} дн. Сумма: {{amount}}.',
    },
    EN: {
      title: 'Payment due soon',
      sms: 'Invoice {{invoiceNumber}} for {{amount}} is due {{dueDate}}, in {{daysUntilDue}} days.',
      inApp:
        'Invoice {{invoiceNumber}} for {{studentName}} is due on {{dueDate}}, in {{daysUntilDue}} days. Amount: {{amount}}.',
    },
  },

  PAYMENT_OVERDUE: {
    UZ: {
      title: "To'lov muddati o'tdi",
      sms: "{{invoiceNumber}} hisobi ({{amount}}) {{daysOverdue}} kun kechikdi. Muddat {{dueDate}}.",
      inApp:
        "{{studentName}} uchun {{invoiceNumber}} hisobi {{daysOverdue}} kun kechikdi. Summa: {{amount}}, to'lov muddati: {{dueDate}}.",
      emailDetail:
        "Iltimos, to'lovni amalga oshiring yoki qayta kelishish uchun o'quv markazga murojaat qiling.",
    },
    RU: {
      title: 'Просроченная оплата',
      sms: 'Счёт {{invoiceNumber}} ({{amount}}) просрочен на {{daysOverdue}} дн. Срок {{dueDate}}.',
      inApp:
        'Счёт {{invoiceNumber}} за {{studentName}} просрочен на {{daysOverdue}} дн. Сумма: {{amount}}, срок оплаты: {{dueDate}}.',
      emailDetail:
        'Пожалуйста, произведите оплату или обратитесь в учебный центр, чтобы согласовать новый срок.',
    },
    EN: {
      title: 'Payment overdue',
      sms: 'Invoice {{invoiceNumber}} ({{amount}}) is {{daysOverdue}} days overdue. Due {{dueDate}}.',
      inApp:
        'Invoice {{invoiceNumber}} for {{studentName}} is {{daysOverdue}} days overdue. Amount: {{amount}}, due date: {{dueDate}}.',
      emailDetail:
        'Please settle the invoice, or contact the office to agree a new date.',
    },
  },

  REFUND_PROCESSED: {
    UZ: {
      title: 'Pul qaytarildi',
      sms: '{{amount}} qaytarildi. {{refundNumber}}, {{processedOn}}.',
      inApp:
        '{{studentName}} uchun {{amount}} miqdorida pul qaytarildi. Hujjat: {{refundNumber}}, sana: {{processedOn}}.',
    },
    RU: {
      title: 'Возврат выполнен',
      sms: 'Возврат {{amount}} выполнен. {{refundNumber}}, {{processedOn}}.',
      inApp:
        'Возврат {{amount}} за {{studentName}} выполнен. Документ: {{refundNumber}}, дата: {{processedOn}}.',
    },
    EN: {
      title: 'Refund processed',
      sms: 'A refund of {{amount}} was processed. {{refundNumber}}, {{processedOn}}.',
      inApp:
        'A refund of {{amount}} for {{studentName}} was processed on {{processedOn}}. Reference: {{refundNumber}}.',
    },
  },

  DISCOUNT_APPROVAL_REQUESTED: {
    UZ: {
      title: 'Chegirma tasdiqlashni kutmoqda',
      sms: '{{requestedBy}}: {{studentName}} uchun {{discountName}} ({{discountValue}}).',
      inApp:
        "{{requestedBy}} {{studentName}} uchun chegirma so'radi: {{discountName}} -- {{discountValue}}. Tasdiqlashingiz kutilmoqda.",
    },
    RU: {
      title: 'Скидка ожидает подтверждения',
      sms: '{{requestedBy}}: {{discountName}} ({{discountValue}}) для {{studentName}}.',
      inApp:
        '{{requestedBy}} запросил(а) скидку для {{studentName}}: {{discountName}} -- {{discountValue}}. Требуется ваше решение.',
    },
    EN: {
      title: 'Discount awaiting approval',
      sms: '{{requestedBy}} requested {{discountName}} ({{discountValue}}) for {{studentName}}.',
      inApp:
        '{{requestedBy}} requested a discount for {{studentName}}: {{discountName}} -- {{discountValue}}. Your approval is needed.',
    },
  },

  // --- Academics ----------------------------------------------------------
  ENROLLMENT_CREATED: {
    UZ: {
      title: 'Guruhga qabul qilindi',
      sms: '{{studentName}} {{groupName}} guruhiga qabul qilindi. Boshlanishi {{startDate}}.',
      inApp:
        '{{studentName}} {{groupName}} guruhiga qabul qilindi.{{#if branchName}} Filial: {{branchName}}.{{/if}} Darslar {{startDate}} dan boshlanadi.',
    },
    RU: {
      title: 'Зачисление в группу',
      sms: '{{studentName}} зачислен(а) в группу {{groupName}}. Начало {{startDate}}.',
      inApp:
        '{{studentName}} зачислен(а) в группу {{groupName}}.{{#if branchName}} Филиал: {{branchName}}.{{/if}} Занятия начинаются {{startDate}}.',
    },
    EN: {
      title: 'Enrolled in a group',
      sms: '{{studentName}} has been enrolled in {{groupName}}, starting {{startDate}}.',
      inApp:
        '{{studentName}} has been enrolled in {{groupName}}.{{#if branchName}} Branch: {{branchName}}.{{/if}} Lessons start on {{startDate}}.',
    },
  },

  SCHEDULE_CHANGED: {
    UZ: {
      title: "Dars jadvali o'zgardi",
      sms: "{{groupName}} jadvali {{effectiveFrom}} dan o'zgaradi: {{changeSummary}}",
      inApp:
        "{{groupName}} guruhining dars jadvali {{effectiveFrom}} dan boshlab o'zgaradi: {{changeSummary}}",
    },
    RU: {
      title: 'Изменение расписания',
      sms: 'Расписание {{groupName}} меняется с {{effectiveFrom}}: {{changeSummary}}',
      inApp:
        'Расписание группы {{groupName}} меняется с {{effectiveFrom}}: {{changeSummary}}',
    },
    EN: {
      title: 'Timetable changed',
      sms: 'The {{groupName}} timetable changes from {{effectiveFrom}}: {{changeSummary}}',
      inApp:
        'The timetable for {{groupName}} changes from {{effectiveFrom}}: {{changeSummary}}',
    },
  },

  LESSON_CANCELLED: {
    UZ: {
      title: 'Dars bekor qilindi',
      sms: '{{groupName}}: {{lessonDate}} {{lessonTime}} dars bekor qilindi.{{#if reason}} {{reason}}{{/if}}',
      inApp:
        '{{groupName}} guruhining {{lessonDate}} kuni soat {{lessonTime}} dagi darsi bekor qilindi.{{#if reason}} Sabab: {{reason}}{{/if}}',
    },
    RU: {
      title: 'Занятие отменено',
      sms: '{{groupName}}: занятие {{lessonDate}} в {{lessonTime}} отменено.{{#if reason}} {{reason}}{{/if}}',
      inApp:
        'Занятие группы {{groupName}} {{lessonDate}} в {{lessonTime}} отменено.{{#if reason}} Причина: {{reason}}{{/if}}',
    },
    EN: {
      title: 'Lesson cancelled',
      sms: '{{groupName}}: the lesson on {{lessonDate}} at {{lessonTime}} is cancelled.{{#if reason}} {{reason}}{{/if}}',
      inApp:
        'The {{groupName}} lesson on {{lessonDate}} at {{lessonTime}} has been cancelled.{{#if reason}} Reason: {{reason}}{{/if}}',
    },
  },

  HOMEWORK_ASSIGNED: {
    UZ: {
      title: 'Yangi uyga vazifa',
      sms: '{{subjectName}}: {{title}}. Muddat {{dueDate}}.',
      inApp:
        '{{subjectName}} fanidan{{#if groupName}} ({{groupName}}){{/if}} yangi vazifa: {{title}}. Topshirish muddati: {{dueDate}}.',
    },
    RU: {
      title: 'Новое домашнее задание',
      sms: '{{subjectName}}: {{title}}. Сдать до {{dueDate}}.',
      inApp:
        'Новое задание по {{subjectName}}{{#if groupName}} ({{groupName}}){{/if}}: {{title}}. Сдать до {{dueDate}}.',
    },
    EN: {
      title: 'New homework',
      sms: '{{subjectName}}: {{title}}. Due {{dueDate}}.',
      inApp:
        'New homework for {{subjectName}}{{#if groupName}} ({{groupName}}){{/if}}: {{title}}. Due {{dueDate}}.',
    },
  },

  GRADE_UPDATED: {
    UZ: {
      title: 'Yangi baho',
      sms: '{{studentName}} -- {{subjectName}}: {{grade}}.',
      inApp:
        '{{studentName}} {{subjectName}} fanidan {{grade}} baho oldi.{{#if comment}} Izoh: {{comment}}{{/if}}',
    },
    RU: {
      title: 'Новая оценка',
      sms: '{{studentName}} -- {{subjectName}}: {{grade}}.',
      inApp:
        '{{studentName}} получил(а) оценку {{grade}} по предмету {{subjectName}}.{{#if comment}} Комментарий: {{comment}}{{/if}}',
    },
    EN: {
      title: 'Grade updated',
      sms: '{{studentName}} -- {{subjectName}}: {{grade}}.',
      inApp:
        '{{studentName}} received {{grade}} in {{subjectName}}.{{#if comment}} Comment: {{comment}}{{/if}}',
    },
  },

  EXAM_SCHEDULED: {
    UZ: {
      title: 'Imtihon sanasi belgilandi',
      sms: '{{examName}} ({{subjectName}}): {{examDate}} {{examTime}}.',
      inApp:
        "{{examName}} imtihoni ({{subjectName}}) {{examDate}} kuni soat {{examTime}} da bo'ladi.{{#if roomName}} Xona: {{roomName}}.{{/if}}",
    },
    RU: {
      title: 'Назначен экзамен',
      sms: '{{examName}} ({{subjectName}}): {{examDate}} в {{examTime}}.',
      inApp:
        'Экзамен {{examName}} по {{subjectName}} состоится {{examDate}} в {{examTime}}.{{#if roomName}} Аудитория: {{roomName}}.{{/if}}',
    },
    EN: {
      title: 'Exam scheduled',
      sms: '{{examName}} ({{subjectName}}): {{examDate}} at {{examTime}}.',
      inApp:
        'The {{examName}} exam in {{subjectName}} will take place on {{examDate}} at {{examTime}}.{{#if roomName}} Room: {{roomName}}.{{/if}}',
    },
  },

  EXAM_RESULT_PUBLISHED: {
    UZ: {
      title: 'Imtihon natijasi',
      sms: '{{examName}}: {{score}}/{{maxScore}}.{{#if passed}} Imtihon topshirildi.{{/if}}',
      inApp:
        "{{studentName}} {{examName}} imtihonida {{score}}/{{maxScore}} ball to'pladi.{{#if passed}} Imtihon muvaffaqiyatli topshirildi.{{/if}}",
    },
    RU: {
      title: 'Результат экзамена',
      sms: '{{examName}}: {{score}}/{{maxScore}}.{{#if passed}} Экзамен сдан.{{/if}}',
      inApp:
        '{{studentName}} набрал(а) {{score}} из {{maxScore}} на экзамене {{examName}}.{{#if passed}} Экзамен сдан.{{/if}}',
    },
    EN: {
      title: 'Exam result',
      sms: '{{examName}}: {{score}}/{{maxScore}}.{{#if passed}} Passed.{{/if}}',
      inApp:
        '{{studentName}} scored {{score}} out of {{maxScore}} in {{examName}}.{{#if passed}} The exam was passed.{{/if}}',
    },
  },

  CERTIFICATE_ISSUED: {
    UZ: {
      title: 'Sertifikat berildi',
      sms: '{{studentName}} ga {{certificateName}} sertifikati berildi ({{certificateNumber}}).',
      inApp:
        '{{issuedOn}} kuni {{studentName}} ga {{certificateName}} sertifikati berildi. Raqami: {{certificateNumber}}.',
    },
    RU: {
      title: 'Выдан сертификат',
      sms: '{{studentName}} выдан сертификат {{certificateName}} ({{certificateNumber}}).',
      inApp:
        '{{issuedOn}} {{studentName}} выдан сертификат {{certificateName}}. Номер: {{certificateNumber}}.',
    },
    EN: {
      title: 'Certificate issued',
      sms: '{{studentName}} received the {{certificateName}} certificate ({{certificateNumber}}).',
      inApp:
        'On {{issuedOn}}, {{studentName}} was issued the {{certificateName}} certificate. Number: {{certificateNumber}}.',
    },
  },

  ANNOUNCEMENT_PUBLISHED: {
    UZ: {
      title: "E'lon: {{title}}",
      sms: '{{title}}: {{summary}}',
      inApp: '{{summary}}{{#if publishedBy}} -- {{publishedBy}}{{/if}}',
    },
    RU: {
      title: 'Объявление: {{title}}',
      sms: '{{title}}: {{summary}}',
      inApp: '{{summary}}{{#if publishedBy}} -- {{publishedBy}}{{/if}}',
    },
    EN: {
      title: 'Announcement: {{title}}',
      sms: '{{title}}: {{summary}}',
      inApp: '{{summary}}{{#if publishedBy}} -- {{publishedBy}}{{/if}}',
    },
  },

  // --- CRM and admissions -------------------------------------------------
  NEW_LEAD_ASSIGNED: {
    UZ: {
      title: 'Sizga yangi mijoz biriktirildi',
      sms: 'Yangi mijoz: {{leadName}}, {{leadPhone}}.{{#if source}} Manba: {{source}}.{{/if}}',
      inApp:
        'Sizga yangi mijoz biriktirildi: {{leadName}} ({{leadPhone}}).{{#if source}} Manba: {{source}}.{{/if}}{{#if assignedBy}} Biriktirdi: {{assignedBy}}.{{/if}}',
    },
    RU: {
      title: 'Вам назначен новый лид',
      sms: 'Новый лид: {{leadName}}, {{leadPhone}}.{{#if source}} Источник: {{source}}.{{/if}}',
      inApp:
        'Вам назначен новый лид: {{leadName}} ({{leadPhone}}).{{#if source}} Источник: {{source}}.{{/if}}{{#if assignedBy}} Назначил(а): {{assignedBy}}.{{/if}}',
    },
    EN: {
      title: 'New lead assigned to you',
      sms: 'New lead: {{leadName}}, {{leadPhone}}.{{#if source}} Source: {{source}}.{{/if}}',
      inApp:
        'A new lead has been assigned to you: {{leadName}} ({{leadPhone}}).{{#if source}} Source: {{source}}.{{/if}}{{#if assignedBy}} Assigned by {{assignedBy}}.{{/if}}',
    },
  },

  FOLLOW_UP_DUE: {
    UZ: {
      title: 'Vazifa muddati keldi',
      sms: 'Vazifa: {{taskTitle}} -- {{dueAt}}.',
      inApp:
        '{{taskTitle}} vazifasining muddati: {{dueAt}}.{{#if relatedName}} Kim bilan: {{relatedName}}.{{/if}}',
    },
    RU: {
      title: 'Пора выполнить задачу',
      sms: 'Задача: {{taskTitle}} -- {{dueAt}}.',
      inApp:
        'Срок задачи {{taskTitle}}: {{dueAt}}.{{#if relatedName}} Контакт: {{relatedName}}.{{/if}}',
    },
    EN: {
      title: 'Follow-up due',
      sms: 'Task: {{taskTitle}} -- {{dueAt}}.',
      inApp:
        'The task {{taskTitle}} is due {{dueAt}}.{{#if relatedName}} Contact: {{relatedName}}.{{/if}}',
    },
  },

  TRIAL_REMINDER: {
    UZ: {
      title: 'Sinov darsi haqida eslatma',
      sms: '{{attendeeName}}, sinov darsi {{trialDate}} {{trialTime}}.{{#if branchName}} {{branchName}}.{{/if}}',
      inApp:
        '{{attendeeName}} uchun sinov darsi {{trialDate}} kuni soat {{trialTime}} da.{{#if groupName}} Guruh: {{groupName}}.{{/if}}{{#if branchName}} Filial: {{branchName}}.{{/if}}',
    },
    RU: {
      title: 'Напоминание о пробном занятии',
      sms: '{{attendeeName}}, пробное занятие {{trialDate}} в {{trialTime}}.{{#if branchName}} {{branchName}}.{{/if}}',
      inApp:
        'Пробное занятие для {{attendeeName}} состоится {{trialDate}} в {{trialTime}}.{{#if groupName}} Группа: {{groupName}}.{{/if}}{{#if branchName}} Филиал: {{branchName}}.{{/if}}',
    },
    EN: {
      title: 'Trial lesson reminder',
      sms: '{{attendeeName}}, your trial lesson is on {{trialDate}} at {{trialTime}}.{{#if branchName}} {{branchName}}.{{/if}}',
      inApp:
        'The trial lesson for {{attendeeName}} is on {{trialDate}} at {{trialTime}}.{{#if groupName}} Group: {{groupName}}.{{/if}}{{#if branchName}} Branch: {{branchName}}.{{/if}}',
    },
  },

  APPLICATION_STATUS_CHANGED: {
    UZ: {
      title: "Ariza holati o'zgardi",
      sms: '{{applicationNumber}}: {{status}}.{{#if nextStep}} {{nextStep}}{{/if}}',
      inApp:
        "{{applicantName}} ning {{applicationNumber}} raqamli arizasi holati: {{status}}.{{#if nextStep}} Keyingi qadam: {{nextStep}}{{/if}}",
    },
    RU: {
      title: 'Статус заявления изменён',
      sms: '{{applicationNumber}}: {{status}}.{{#if nextStep}} {{nextStep}}{{/if}}',
      inApp:
        'Статус заявления {{applicationNumber}} ({{applicantName}}): {{status}}.{{#if nextStep}} Следующий шаг: {{nextStep}}{{/if}}',
    },
    EN: {
      title: 'Application status changed',
      sms: '{{applicationNumber}}: {{status}}.{{#if nextStep}} {{nextStep}}{{/if}}',
      inApp:
        'Application {{applicationNumber}} for {{applicantName}} is now {{status}}.{{#if nextStep}} Next step: {{nextStep}}{{/if}}',
    },
  },

  // --- HR -----------------------------------------------------------------
  LEAVE_REQUEST_SUBMITTED: {
    UZ: {
      title: "Ta'til so'rovi qaror kutmoqda",
      sms: '{{employeeName}}: {{leaveType}}, {{fromDate}} - {{toDate}} ({{dayCount}} kun).',
      inApp:
        "{{employeeName}} {{leaveType}} so'rovini yubordi: {{fromDate}} - {{toDate}}, {{dayCount}} kun. Qaroringiz kutilmoqda.",
    },
    RU: {
      title: 'Заявка на отпуск ожидает решения',
      sms: '{{employeeName}}: {{leaveType}}, {{fromDate}} - {{toDate}} ({{dayCount}} дн.).',
      inApp:
        '{{employeeName}} подал(а) заявку: {{leaveType}}, {{fromDate}} - {{toDate}}, {{dayCount}} дн. Требуется ваше решение.',
    },
    EN: {
      title: 'Leave request awaiting decision',
      sms: '{{employeeName}}: {{leaveType}}, {{fromDate}} - {{toDate}} ({{dayCount}} days).',
      inApp:
        '{{employeeName}} requested {{leaveType}} from {{fromDate}} to {{toDate}}, {{dayCount}} days. Your decision is needed.',
    },
  },

  LEAVE_REQUEST_DECIDED: {
    UZ: {
      title: "Ta'til so'rovi bo'yicha qaror",
      sms: '{{leaveType}} ({{fromDate}} - {{toDate}}): {{decision}}.',
      inApp:
        "{{employeeName}} ning {{leaveType}} so'rovi ({{fromDate}} - {{toDate}}) bo'yicha qaror: {{decision}}. Qabul qildi: {{decidedBy}}.{{#if reason}} Izoh: {{reason}}{{/if}}",
    },
    RU: {
      title: 'Решение по заявке на отпуск',
      sms: '{{leaveType}} ({{fromDate}} - {{toDate}}): {{decision}}.',
      inApp:
        'Заявка {{employeeName}} ({{leaveType}}, {{fromDate}} - {{toDate}}): {{decision}}. Решение принял(а) {{decidedBy}}.{{#if reason}} Комментарий: {{reason}}{{/if}}',
    },
    EN: {
      title: 'Leave request decision',
      sms: '{{leaveType}} ({{fromDate}} - {{toDate}}): {{decision}}.',
      inApp:
        'The {{leaveType}} request from {{employeeName}} for {{fromDate}} - {{toDate}} was {{decision}} by {{decidedBy}}.{{#if reason}} Note: {{reason}}{{/if}}',
    },
  },

  // --- Account and security ----------------------------------------------
  ACCOUNT_CREATED: {
    UZ: {
      title: '{{organizationName}} tizimiga kirish',
      sms: "{{organizationName}}: hisobingiz yaratildi. Parol o'rnatish -- {{loginUrl}}",
      inApp:
        "{{userName}}, {{organizationName}} tizimida hisobingiz yaratildi. Parolni o'rnatish uchun quyidagi havolaga o'ting: {{loginUrl}}",
      emailDetail:
        "Havola faqat siz uchun. Uni boshqalarga yubormang -- parolni o'rnatgach, havola ishlamaydi.",
    },
    RU: {
      title: 'Доступ в систему {{organizationName}}',
      sms: '{{organizationName}}: учётная запись создана. Пароль — {{loginUrl}}',
      inApp:
        '{{userName}}, для вас создана учётная запись в системе {{organizationName}}. Задайте пароль по ссылке: {{loginUrl}}',
      emailDetail:
        'Ссылка предназначена только для вас. Не передавайте её -- после установки пароля она перестанет работать.',
    },
    EN: {
      title: 'Your {{organizationName}} account',
      sms: '{{organizationName}}: your account is ready. Set a password -- {{loginUrl}}',
      inApp:
        '{{userName}}, an account has been created for you in {{organizationName}}. Set your password here: {{loginUrl}}',
      emailDetail:
        'This link is for you alone. Do not forward it -- it stops working once your password is set.',
    },
  },

  PASSWORD_RESET: {
    UZ: {
      title: 'Parolni tiklash',
      sms: 'Parolni tiklash: {{resetUrl}} ({{expiresInMinutes}} daqiqa).',
      inApp:
        "{{userName}}, parolni tiklash havolasi: {{resetUrl}}. Havola {{expiresInMinutes}} daqiqa amal qiladi.",
      emailDetail:
        "Agar bu so'rovni siz yubormagan bo'lsangiz, xabarni e'tiborsiz qoldiring -- parolingiz o'zgarmaydi.",
    },
    RU: {
      title: 'Восстановление пароля',
      sms: 'Сброс пароля: {{resetUrl}} ({{expiresInMinutes}} мин.).',
      inApp:
        '{{userName}}, ссылка для сброса пароля: {{resetUrl}}. Она действует {{expiresInMinutes}} мин.',
      emailDetail:
        'Если вы не запрашивали сброс, просто проигнорируйте письмо -- пароль останется прежним.',
    },
    EN: {
      title: 'Password reset',
      sms: 'Reset your password: {{resetUrl}} (valid {{expiresInMinutes}} min).',
      inApp:
        '{{userName}}, here is your password reset link: {{resetUrl}}. It is valid for {{expiresInMinutes}} minutes.',
      emailDetail:
        'If you did not ask for a reset, ignore this message -- your password stays as it is.',
    },
  },

  SECURITY_ALERT: {
    UZ: {
      title: 'Xavfsizlik ogohlantirishi',
      sms: "Hisobingizda: {{alertKind}} ({{occurredAt}}). Bu siz bo'lmasangiz, parolni almashtiring.",
      inApp:
        '{{userName}}, hisobingizda {{alertKind}} qayd etildi ({{occurredAt}}).{{#if ipAddress}} IP: {{ipAddress}}.{{/if}}{{#if location}} Joylashuv: {{location}}.{{/if}}',
      emailDetail:
        "Agar bu siz bo'lmasangiz, darhol parolni almashtiring va ma'muriyatga xabar bering.",
    },
    RU: {
      title: 'Предупреждение безопасности',
      sms: 'В вашем аккаунте: {{alertKind}} ({{occurredAt}}). Если это не вы, смените пароль.',
      inApp:
        '{{userName}}, в вашем аккаунте зафиксировано: {{alertKind}} ({{occurredAt}}).{{#if ipAddress}} IP: {{ipAddress}}.{{/if}}{{#if location}} Расположение: {{location}}.{{/if}}',
      emailDetail:
        'Если это были не вы, немедленно смените пароль и сообщите администрации.',
    },
    EN: {
      title: 'Security alert',
      sms: 'On your account: {{alertKind}} ({{occurredAt}}). If this was not you, change your password.',
      inApp:
        '{{userName}}, your account recorded: {{alertKind}} ({{occurredAt}}).{{#if ipAddress}} IP: {{ipAddress}}.{{/if}}{{#if location}} Location: {{location}}.{{/if}}',
      emailDetail:
        'If this was not you, change your password immediately and tell an administrator.',
    },
  },
} as const satisfies Record<NotificationEvent, EventCopy>;

// ---------------------------------------------------------------------------
// Expansion into seed rows
// ---------------------------------------------------------------------------

/** Locale order is the display order of the settings screen, not an alphabet. */
export const TEMPLATE_LOCALES: readonly Locale[] = ['UZ', 'RU', 'EN'];

/** See the file header for why the other three channels are absent. */
export const SEEDED_TEMPLATE_CHANNELS: readonly NotificationChannel[] = ['IN_APP', 'SMS', 'EMAIL'];

/**
 * A row as `prisma/seed` inserts it. `organizationId` is the seed's to supply --
 * the same set is inserted for every tenant, and putting an id here would invite
 * a cross-tenant mistake.
 */
export interface NotificationTemplateSeed {
  readonly key: string;
  readonly event: NotificationEvent;
  readonly channel: NotificationChannel;
  readonly locale: Locale;
  /** Null for SMS, which has no subject line to carry. */
  readonly subject: string | null;
  readonly body: string;
  /**
   * The placeholders an operator may use here -- the event's whole variable set,
   * not just the ones this body happens to reference, because the settings UI
   * validates an EDITED body against this list.
   */
  readonly variables: readonly string[];
}

function emailBody(locale: Locale, copy: LocalisedCopy): string {
  const envelope = EMAIL_ENVELOPE[locale];
  const blocks = [envelope.greeting, copy.inApp];
  if (copy.emailDetail) blocks.push(copy.emailDetail);
  blocks.push(envelope.footer);
  return blocks.join('\n\n');
}

function seedRow(
  event: NotificationEvent,
  channel: NotificationChannel,
  locale: Locale,
  copy: LocalisedCopy,
  variables: readonly string[],
): NotificationTemplateSeed {
  const base = {
    key: NOTIFICATION_EVENTS[event].templateKey,
    event,
    channel,
    locale,
    variables,
  } as const;

  switch (channel) {
    case 'SMS':
      return { ...base, subject: null, body: copy.sms };
    case 'EMAIL':
      return { ...base, subject: copy.title, body: emailBody(locale, copy) };
    default:
      return { ...base, subject: copy.title, body: copy.inApp };
  }
}

function buildDefaults(): readonly NotificationTemplateSeed[] {
  const rows: NotificationTemplateSeed[] = [];
  for (const event of NOTIFICATION_EVENT_KEYS) {
    const variables = eventVariableNames(event);
    for (const locale of TEMPLATE_LOCALES) {
      const copy = NOTIFICATION_TEMPLATE_COPY[event][locale];
      for (const channel of SEEDED_TEMPLATE_CHANNELS) {
        rows.push(seedRow(event, channel, locale, copy, variables));
      }
    }
  }
  return rows;
}

export const DEFAULT_NOTIFICATION_TEMPLATES: readonly NotificationTemplateSeed[] = buildDefaults();

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function lookupKey(event: NotificationEvent, channel: NotificationChannel, locale: Locale): string {
  return `${event}:${channel}:${locale}`;
}

const BY_EVENT_CHANNEL_LOCALE = new Map<string, NotificationTemplateSeed>(
  DEFAULT_NOTIFICATION_TEMPLATES.map((row) => [lookupKey(row.event, row.channel, row.locale), row]),
);

/**
 * Which seeded body a channel borrows.
 *
 * WhatsApp and Telegram carry the short text: both are read on a phone in the
 * same glance as an SMS, and a body written for an email would be wrong there.
 * Push has no stored body at all yet, so it borrows the short text too rather
 * than rendering nothing.
 */
function bodyChannelFor(channel: NotificationChannel): NotificationChannel {
  switch (channel) {
    case 'IN_APP':
    case 'EMAIL':
      return channel;
    default:
      return 'SMS';
  }
}

/**
 * The built-in template for an event, or null when this build has none.
 *
 * Returns null rather than throwing: `dispatch` treats a missing template as a
 * reason to skip the notification honestly, and an unrenderable message must not
 * be able to fail the transaction that queued it.
 */
export function findDefaultTemplate(
  event: NotificationEvent,
  channel: NotificationChannel,
  locale: Locale,
): NotificationTemplateSeed | null {
  return BY_EVENT_CHANNEL_LOCALE.get(lookupKey(event, bodyChannelFor(channel), locale)) ?? null;
}

// ---------------------------------------------------------------------------
// Load-time cross-check
//
// The point of this module is that operator-visible text and the event contract
// cannot drift apart. A typo caught here fails the process at import, i.e. in
// the seed run or the first request after a deploy; caught nowhere, it is a
// blank space in every message of that kind until somebody complains.
// ---------------------------------------------------------------------------

(function assertTemplatesMatchTheirEvents(): void {
  const problems: string[] = [];

  for (const row of DEFAULT_NOTIFICATION_TEMPLATES) {
    const where = `${row.event}/${row.channel}/${row.locale}`;
    for (const [part, source] of [
      ['body', row.body],
      ['subject', row.subject],
    ] as const) {
      if (source === null) continue;
      const result = validateTemplate(source, row.variables);
      for (const error of result.syntaxErrors) problems.push(`${where} ${part}: ${error}`);
      for (const variable of result.undeclaredVariables) {
        problems.push(`${where} ${part}: {{${variable}}} is not supplied by ${row.event}.`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Default notification templates are inconsistent:\n- ${problems.join('\n- ')}`);
  }
})();
