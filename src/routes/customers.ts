import { Router } from "express";
import multer from "multer";
import { getSessionAccount } from "../services/api";
import {
  MissingRequiredColumnsError,
  importCabcherBookings,
  listImportBatches
} from "../services/cabcher-import";
import {
  CUSTOMER_DEFAULT_PER_PAGE,
  CUSTOMER_PER_PAGE_OPTIONS,
  CUSTOMER_STATUS_OPTIONS,
  CustomerRecord,
  CustomerStatus,
  createCustomer,
  getCustomerById,
  getCustomerCount,
  listCustomers,
  updateCustomer
} from "../services/customers";

type CustomersRouterOptions = {
  appTitle: string;
};

type NoticeTone = "warning" | "critical";

type PageNotice = {
  message: string;
  tone: NoticeTone;
};

type CustomerStatusTab = {
  label: string;
  href: string;
  isActive: boolean;
};

type PaginationLink = {
  href: string;
  label: string;
  isActive: boolean;
};

type PaginationModel = {
  currentPage: number;
  totalPages: number;
  totalRecords: number;
  startRecord: number;
  endRecord: number;
  previousHref: string | null;
  nextHref: string | null;
  pageLinks: PaginationLink[];
};

function getRoleLabel(role: string): string {
  return role === "admin" ? "Administration" : role;
}

function formatDate(value: string | null): string {
  if (!value) {
    return "—";
  }

  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

function formatBookingDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function getLastBookingAt(customer: CustomerRecord): string | null {
  return customer.lastBookingAt || customer.bookings.reduce<string | null>(
    (latest, booking) => (!latest || booking.serviceDate > latest ? booking.serviceDate : latest),
    null
  );
}

function formatPhoneHref(phone: string | null): string | null {
  if (!phone) {
    return null;
  }

  const digits = phone.replace(/[^\d]/g, "");
  return digits ? `https://wa.me/${digits}` : null;
}

function resolveReturnTo(returnTo: unknown, fallback: string): string {
  const value = String(returnTo || "").trim();
  if (!value.startsWith("/")) {
    return fallback;
  }

  if (value.startsWith("//") || value.startsWith("/\\")) {
    return fallback;
  }

  try {
    const resolvedUrl = new URL(value, "http://localhost");
    const safePath = `${resolvedUrl.pathname}${resolvedUrl.search}`;

    if (!safePath.startsWith("/customers")) {
      return fallback;
    }

    return safePath;
  } catch {
    return fallback;
  }
}

function buildCustomersListHref(params: {
  search?: string;
  status?: CustomerStatus;
  page?: number;
  perPage?: number;
  notice?: string;
}): string {
  const searchParams = new URLSearchParams();

  if (params.search) {
    searchParams.set("q", params.search);
  }

  if (params.status && params.status !== "all") {
    searchParams.set("status", params.status);
  }

  if (params.page && params.page > 1) {
    searchParams.set("page", String(params.page));
  }

  if (params.perPage && params.perPage !== CUSTOMER_DEFAULT_PER_PAGE) {
    searchParams.set("perPage", String(params.perPage));
  }

  if (params.notice) {
    searchParams.set("notice", params.notice);
  }

  const query = searchParams.toString();
  return query ? `/customers?${query}` : "/customers";
}

function buildCustomerHref(customerId: string, params: { returnTo?: string; notice?: string }): string {
  const searchParams = new URLSearchParams();

  if (params.returnTo) {
    searchParams.set("returnTo", params.returnTo);
  }

  if (params.notice) {
    searchParams.set("notice", params.notice);
  }

  const query = searchParams.toString();
  return query ? `/customers/${customerId}?${query}` : `/customers/${customerId}`;
}

function buildCustomerBookingsHref(customerId: string, returnTo?: string, notice?: string): string {
  const searchParams = new URLSearchParams();

  if (returnTo) {
    searchParams.set("returnTo", returnTo);
  }

  if (notice) {
    searchParams.set("notice", notice);
  }

  const query = searchParams.toString();
  return query ? `/customers/${customerId}/bookings?${query}` : `/customers/${customerId}/bookings`;
}

function getStatusTabs(search: string, page: number, perPage: number, activeStatus: CustomerStatus): CustomerStatusTab[] {
  return CUSTOMER_STATUS_OPTIONS.map((status) => ({
    label: status === "all" ? "All" : status,
    href: buildCustomersListHref({
      search,
      status,
      page: status === activeStatus ? page : 1,
      perPage
    }),
    isActive: status === activeStatus
  }));
}

function getPagination(search: string, status: CustomerStatus, currentPage: number, totalPages: number, perPage: number, totalRecords: number): PaginationModel {
  const startRecord = totalRecords === 0 ? 0 : (currentPage - 1) * perPage + 1;
  const endRecord = totalRecords === 0 ? 0 : Math.min(totalRecords, currentPage * perPage);
  const pageLinks: PaginationLink[] = [];

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    pageLinks.push({
      href: buildCustomersListHref({ search, status, page: pageNumber, perPage }),
      label: String(pageNumber),
      isActive: pageNumber === currentPage
    });
  }

  return {
    currentPage,
    totalPages,
    totalRecords,
    startRecord,
    endRecord,
    previousHref:
      currentPage > 1
        ? buildCustomersListHref({ search, status, page: currentPage - 1, perPage })
        : null,
    nextHref:
      currentPage < totalPages
        ? buildCustomersListHref({ search, status, page: currentPage + 1, perPage })
        : null,
    pageLinks
  };
}

function getNotice(code: unknown, customer?: CustomerRecord): PageNotice | undefined {
  const name = customer ? `${customer.surname}, ${customer.givenName}` : "This customer";

  switch (String(code || "")) {
    case "customer-created":
      return {
        tone: "warning",
        message: `${name} has been created successfully.`
      };
    case "customer-updated":
      return {
        tone: "warning",
        message: `${name} has been updated successfully.`
      };
    case "new-customer":
      return {
        tone: "warning",
        message: "New Customer is visible in the workflow, but the creation form is not connected to backend persistence yet."
      };
    case "edit-customer":
      return {
        tone: "warning",
        message: `${name} can be reviewed here, but the edit workflow is still a placeholder until the backend editor is available.`
      };
    case "new-booking":
      return {
        tone: "warning",
        message: `New Booking is reserved as the primary CTA for ${name}, but booking creation is not connected in this web layer yet.`
      };
    case "suspend-customer":
      return {
        tone: "warning",
        message: `Suspend Customer is wired as an administrative action for ${name}, but the reversible status change is not persisted by the backend yet.`
      };
    case "delete-customer":
      return {
        tone: "critical",
        message: `${name} was not deleted because destructive deletion is not connected to the backend yet.`
      };
    default:
      return undefined;
  }
}

async function requireAdminSession(
  cookieHeader: string | undefined
): Promise<{ email: string; activeRoleLabel: string }> {
  const session = await getSessionAccount(cookieHeader);

  if (!session.authenticated || !session.user) {
    throw new Error("unauthenticated");
  }

  const roles = Array.isArray(session.user.roles) ? session.user.roles : [];

  if (!roles.includes("admin")) {
    throw new Error("forbidden");
  }

  return {
    email: session.user.email,
    activeRoleLabel: getRoleLabel(session.user.active_role || "admin")
  };
}

function isValidEmail(email: string): boolean {
  const at = email.indexOf("@");
  if (at < 1) return false;
  const domain = email.slice(at + 1);
  const dot = domain.indexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

export function createCustomersRouter(options: CustomersRouterOptions): Router {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage() });

  router.get("/customers", async (req, res, next) => {
    try {
      const session = await requireAdminSession(req.headers.cookie);
      const search = String(req.query.q || "").trim();
      const requestedStatus = String(req.query.status || "all");
      const status = CUSTOMER_STATUS_OPTIONS.includes(requestedStatus as CustomerStatus)
        ? (requestedStatus as CustomerStatus)
        : "all";
      const requestedPage = Number.parseInt(String(req.query.page || "1"), 10);
      const requestedPerPage = Number.parseInt(String(req.query.perPage || CUSTOMER_DEFAULT_PER_PAGE), 10);
      const result = listCustomers({
        search,
        status,
        page: Number.isFinite(requestedPage) ? requestedPage : 1,
        perPage: Number.isFinite(requestedPerPage) ? requestedPerPage : CUSTOMER_DEFAULT_PER_PAGE
      });

      const pagination = getPagination(search, status, result.page, result.totalPages, result.perPage, result.totalRecords);

      return res.render("pages/customers/index", {
        title: "Customers",
        appTitle: options.appTitle,
        email: session.email,
        activeRoleLabel: session.activeRoleLabel,
        customers: result.customers.map((customer) => ({
          ...customer,
          formattedCreatedAt: formatDate(customer.createdAt),
          formattedLastLoginAt: formatDateTime(customer.lastLoginAt),
          formattedLastBookingAt: formatDateTime(getLastBookingAt(customer)),
          detailHref: buildCustomerHref(customer.id, {
            returnTo: buildCustomersListHref({
              search,
              status,
              page: result.page,
              perPage: result.perPage
            })
          }),
          editHref: buildCustomerHref(customer.id, {
            returnTo: buildCustomersListHref({
              search,
              status,
              page: result.page,
              perPage: result.perPage
            }),
            notice: "edit-customer"
          }),
          deleteHref: `/customers/${customer.id}/delete?returnTo=${encodeURIComponent(
            buildCustomersListHref({
              search,
              status,
              page: result.page,
              perPage: result.perPage
            })
          )}`
        })),
        customerCount: getCustomerCount(),
        hasSearchFilters: Boolean(search || status !== "all"),
        notice: getNotice(req.query.notice),
        pagination,
        search,
        status,
        perPage: result.perPage,
        perPageOptions: CUSTOMER_PER_PAGE_OPTIONS,
        statusTabs: getStatusTabs(search, result.page, result.perPage, status)
      });
    } catch (error) {
      if (error instanceof Error && error.message === "unauthenticated") {
        return res.redirect("/access");
      }

      if (error instanceof Error && error.message === "forbidden") {
        return res.status(403).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      return next(error);
    }
  });

  router.get("/customers/import", async (req, res, next) => {
    try {
      const session = await requireAdminSession(req.headers.cookie);

      return res.render("pages/customers/import", {
        title: "Customers Import",
        appTitle: options.appTitle,
        email: session.email,
        activeRoleLabel: session.activeRoleLabel,
        latestBatches: listImportBatches().slice(0, 5),
        summary: null,
        errors: []
      });
    } catch (error) {
      if (error instanceof Error && error.message === "unauthenticated") {
        return res.redirect("/access");
      }

      if (error instanceof Error && error.message === "forbidden") {
        return res.status(403).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      return next(error);
    }
  });

  router.post("/customers/import", upload.single("bookingsCsv"), async (req, res, next) => {
    let sessionContext: { email: string; activeRoleLabel: string } | null = null;

    try {
      const session = await requireAdminSession(req.headers.cookie);
      sessionContext = session;
      const uploadedFile = req.file;

      if (!uploadedFile || !uploadedFile.buffer || uploadedFile.size === 0) {
        return res.status(400).render("pages/customers/import", {
          title: "Customers Import",
          appTitle: options.appTitle,
          email: session.email,
          activeRoleLabel: session.activeRoleLabel,
          latestBatches: listImportBatches().slice(0, 5),
          summary: null,
          errors: ["Please upload a non-empty CSV file."]
        });
      }

      const result = importCabcherBookings({
        csvContent: uploadedFile.buffer.toString("utf-8"),
        originalFilename: uploadedFile.originalname,
        uploadedBy: session.email
      });

      return res.render("pages/customers/import", {
        title: "Customers Import",
        appTitle: options.appTitle,
        email: session.email,
        activeRoleLabel: session.activeRoleLabel,
        latestBatches: listImportBatches().slice(0, 5),
        summary: result.summary,
        errors: []
      });
    } catch (error) {
      if (error instanceof Error && error.message === "unauthenticated") {
        return res.redirect("/access");
      }

      if (error instanceof Error && error.message === "forbidden") {
        return res.status(403).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      if (error instanceof MissingRequiredColumnsError) {
        return res.status(400).render("pages/customers/import", {
          title: "Customers Import",
          appTitle: options.appTitle,
          email: sessionContext?.email || "",
          activeRoleLabel: sessionContext?.activeRoleLabel || "Administration",
          latestBatches: listImportBatches().slice(0, 5),
          summary: null,
          errors: [`Missing required columns: ${error.missingColumns.join(", ")}`]
        });
      }

      return next(error);
    }
  });

  router.get("/customers/register", async (req, res, next) => {
    try {
      const session = await requireAdminSession(req.headers.cookie);

      return res.render("pages/customers/register", {
        title: "New Customer",
        appTitle: options.appTitle,
        email: session.email,
        activeRoleLabel: session.activeRoleLabel,
        formData: {},
        errors: []
      });
    } catch (error) {
      if (error instanceof Error && error.message === "unauthenticated") {
        return res.redirect("/access");
      }

      if (error instanceof Error && error.message === "forbidden") {
        return res.status(403).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      return next(error);
    }
  });

  router.post("/customers/register", async (req, res, next) => {
    let sessionContext: { email: string; activeRoleLabel: string } | null = null;

    try {
      sessionContext = await requireAdminSession(req.headers.cookie);
    } catch (error) {
      if (error instanceof Error && error.message === "unauthenticated") {
        return res.redirect("/access");
      }

      if (error instanceof Error && error.message === "forbidden") {
        return res.status(403).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      return next(error);
    }

    const registerFormData = {
      givenName: String(req.body.givenName || "").trim(),
      surname: String(req.body.surname || "").trim(),
      email: String(req.body.email || "").trim(),
      phone: String(req.body.phone || "").trim(),
      company: String(req.body.company || "").trim(),
      address: String(req.body.address || "").trim(),
      notes: String(req.body.notes || "").trim(),
      preferredContact: String(req.body.preferredContact || "Unknown")
    };

    const registerErrors: string[] = [];

    if (!registerFormData.givenName) registerErrors.push("First name is required.");
    if (!registerFormData.surname) registerErrors.push("Surname is required.");
    if (!registerFormData.email) {
      registerErrors.push("Email address is required.");
    } else if (!isValidEmail(registerFormData.email)) {
      registerErrors.push("Email address is not valid.");
    }

    if (registerErrors.length > 0) {
      return res.status(400).render("pages/customers/register", {
        title: "New Customer",
        appTitle: options.appTitle,
        email: sessionContext.email,
        activeRoleLabel: sessionContext.activeRoleLabel,
        formData: registerFormData,
        errors: registerErrors
      });
    }

    try {
      const newCustomer = createCustomer({
        givenName: registerFormData.givenName,
        surname: registerFormData.surname,
        email: registerFormData.email || null,
        phone: registerFormData.phone || null,
        company: registerFormData.company || null,
        address: registerFormData.address || null,
        notes: registerFormData.notes || null,
        preferredContact: ["WhatsApp", "Email", "Phone", "Unknown"].includes(registerFormData.preferredContact)
          ? (registerFormData.preferredContact as "WhatsApp" | "Email" | "Phone" | "Unknown")
          : "Unknown"
      });

      return res.redirect(
        buildCustomerHref(newCustomer.id, { notice: "customer-created", returnTo: "/customers" })
      );
    } catch (err) {
      return next(err);
    }
  });

  router.get("/customers/:customerId", async (req, res, next) => {
    try {
      const session = await requireAdminSession(req.headers.cookie);
      const customer = getCustomerById(req.params.customerId);

      if (!customer) {
        return res.status(404).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      const backToCustomersHref = resolveReturnTo(req.query.returnTo, "/customers");

      return res.render("pages/customers/detail", {
        title: `${customer.surname}, ${customer.givenName}`,
        appTitle: options.appTitle,
        email: session.email,
        activeRoleLabel: session.activeRoleLabel,
        customer: {
          ...customer,
          formattedCreatedAt: formatDate(customer.createdAt),
          formattedLastLoginAt: formatDateTime(customer.lastLoginAt),
          bookings: customer.bookings.map((booking) => ({
            ...booking,
            formattedServiceDate: formatBookingDate(booking.serviceDate)
          })),
          whatsappHref: formatPhoneHref(customer.phone),
          emailHref: customer.email ? `mailto:${customer.email}` : null,
          deleteHref: `/customers/${customer.id}/delete?returnTo=${encodeURIComponent(backToCustomersHref)}`,
          bookingsHref: buildCustomerBookingsHref(customer.id, backToCustomersHref),
          newBookingHref: buildCustomerHref(customer.id, {
            returnTo: backToCustomersHref,
            notice: "new-booking"
          }),
          editHref: `/customers/${customer.id}/edit?returnTo=${encodeURIComponent(backToCustomersHref)}`
        },
        backToCustomersHref,
        notice: getNotice(req.query.notice, customer)
      });
    } catch (error) {
      if (error instanceof Error && error.message === "unauthenticated") {
        return res.redirect("/access");
      }

      if (error instanceof Error && error.message === "forbidden") {
        return res.status(403).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      return next(error);
    }
  });

  router.post("/customers/:customerId/suspend", async (req, res, next) => {
    try {
      await requireAdminSession(req.headers.cookie);
      const customer = getCustomerById(req.params.customerId);

      if (!customer) {
        return res.status(404).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      const returnTo = resolveReturnTo(req.query.returnTo, "/customers");
      return res.redirect(buildCustomerHref(customer.id, { returnTo, notice: "suspend-customer" }));
    } catch (error) {
      if (error instanceof Error && error.message === "unauthenticated") {
        return res.redirect("/access");
      }

      if (error instanceof Error && error.message === "forbidden") {
        return res.status(403).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      return next(error);
    }
  });

  router.get("/customers/:customerId/bookings", async (req, res, next) => {
    try {
      const session = await requireAdminSession(req.headers.cookie);
      const customer = getCustomerById(req.params.customerId);

      if (!customer) {
        return res.status(404).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      const backToCustomersHref = resolveReturnTo(req.query.returnTo, "/customers");

      return res.render("pages/customers/bookings", {
        title: `${customer.surname}, ${customer.givenName} Bookings`,
        appTitle: options.appTitle,
        email: session.email,
        activeRoleLabel: session.activeRoleLabel,
        customer: {
          ...customer,
          formattedCreatedAt: formatDate(customer.createdAt),
          bookings: customer.bookings.map((booking) => ({
            ...booking,
            formattedServiceDate: formatBookingDate(booking.serviceDate)
          }))
        },
        backToCustomersHref,
        notice: getNotice(req.query.notice, customer)
      });
    } catch (error) {
      if (error instanceof Error && error.message === "unauthenticated") {
        return res.redirect("/access");
      }

      if (error instanceof Error && error.message === "forbidden") {
        return res.status(403).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      return next(error);
    }
  });

  router.get("/customers/:customerId/delete", async (req, res, next) => {
    try {
      const session = await requireAdminSession(req.headers.cookie);
      const customer = getCustomerById(req.params.customerId);

      if (!customer) {
        return res.status(404).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      const backToCustomersHref = resolveReturnTo(req.query.returnTo, "/customers");

      return res.render("pages/customers/delete", {
        title: `Delete ${customer.surname}, ${customer.givenName}`,
        appTitle: options.appTitle,
        email: session.email,
        activeRoleLabel: session.activeRoleLabel,
        customer,
        backToCustomersHref
      });
    } catch (error) {
      if (error instanceof Error && error.message === "unauthenticated") {
        return res.redirect("/access");
      }

      if (error instanceof Error && error.message === "forbidden") {
        return res.status(403).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      return next(error);
    }
  });

  router.post("/customers/:customerId/delete", async (req, res, next) => {
    try {
      await requireAdminSession(req.headers.cookie);
      const customer = getCustomerById(req.params.customerId);

      if (!customer) {
        return res.status(404).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      const returnTo = resolveReturnTo(req.query.returnTo, "/customers");
      return res.redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}notice=delete-customer`);
    } catch (error) {
      if (error instanceof Error && error.message === "unauthenticated") {
        return res.redirect("/access");
      }

      if (error instanceof Error && error.message === "forbidden") {
        return res.status(403).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      return next(error);
    }
  });

  router.get("/customers/:customerId/edit", async (req, res, next) => {
    try {
      const session = await requireAdminSession(req.headers.cookie);
      const customer = getCustomerById(req.params.customerId);

      if (!customer) {
        return res.status(404).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      const backToCustomersHref = resolveReturnTo(req.query.returnTo, "/customers");

      return res.render("pages/customers/edit", {
        title: `Edit ${customer.surname}, ${customer.givenName}`,
        appTitle: options.appTitle,
        email: session.email,
        activeRoleLabel: session.activeRoleLabel,
        customer,
        backToCustomersHref,
        formData: {
          givenName: customer.givenName,
          surname: customer.surname,
          email: customer.email || "",
          phone: customer.phone || "",
          company: customer.company || "",
          address: customer.address || "",
          notes: customer.notes || "",
          preferredContact: customer.preferredContact,
          status: customer.status
        },
        errors: []
      });
    } catch (error) {
      if (error instanceof Error && error.message === "unauthenticated") {
        return res.redirect("/access");
      }

      if (error instanceof Error && error.message === "forbidden") {
        return res.status(403).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      return next(error);
    }
  });

  router.post("/customers/:customerId/edit", async (req, res, next) => {
    let sessionContext: { email: string; activeRoleLabel: string } | null = null;

    try {
      sessionContext = await requireAdminSession(req.headers.cookie);
    } catch (error) {
      if (error instanceof Error && error.message === "unauthenticated") {
        return res.redirect("/access");
      }

      if (error instanceof Error && error.message === "forbidden") {
        return res.status(403).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      return next(error);
    }

    const customer = getCustomerById(req.params.customerId);

    if (!customer) {
      return res.status(404).render("pages/unavailable", {
        title: "Unavailable",
        appTitle: options.appTitle
      });
    }

    const backToCustomersHref = resolveReturnTo(req.query.returnTo, "/customers");

    const formData = {
      givenName: String(req.body.givenName || "").trim(),
      surname: String(req.body.surname || "").trim(),
      email: String(req.body.email || "").trim(),
      phone: String(req.body.phone || "").trim(),
      company: String(req.body.company || "").trim(),
      address: String(req.body.address || "").trim(),
      notes: String(req.body.notes || "").trim(),
      preferredContact: String(req.body.preferredContact || "Unknown"),
      status: String(req.body.status || "Active")
    };

    const errors: string[] = [];

    if (!formData.givenName) errors.push("First name is required.");
    if (!formData.surname) errors.push("Surname is required.");
    if (formData.email && !isValidEmail(formData.email)) {
      errors.push("Email address is not valid.");
    }

    if (errors.length > 0) {
      return res.status(400).render("pages/customers/edit", {
        title: `Edit ${customer.surname}, ${customer.givenName}`,
        appTitle: options.appTitle,
        email: sessionContext.email,
        activeRoleLabel: sessionContext.activeRoleLabel,
        customer,
        backToCustomersHref,
        formData,
        errors
      });
    }

    try {
      const updated = updateCustomer(customer.id, {
        givenName: formData.givenName,
        surname: formData.surname,
        email: formData.email || null,
        phone: formData.phone || null,
        company: formData.company || null,
        address: formData.address || null,
        notes: formData.notes || null,
        preferredContact: ["WhatsApp", "Email", "Phone", "Unknown"].includes(formData.preferredContact)
          ? (formData.preferredContact as "WhatsApp" | "Email" | "Phone" | "Unknown")
          : "Unknown",
        status: (["Active", "Suspended", "Pending", "Delete Pending"] as const).includes(
          formData.status as "Active" | "Suspended" | "Pending" | "Delete Pending"
        )
          ? (formData.status as "Active" | "Suspended" | "Pending" | "Delete Pending")
          : undefined
      });

      if (!updated) {
        return res.status(404).render("pages/unavailable", {
          title: "Unavailable",
          appTitle: options.appTitle
        });
      }

      return res.redirect(
        buildCustomerHref(updated.id, { notice: "customer-updated", returnTo: backToCustomersHref })
      );
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
