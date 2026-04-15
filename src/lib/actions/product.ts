"use server";

import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  brands,
  categories,
  genders,
  productImages,
  productVariants,
  products,
  sizes,
  colors,
  users,
  reviews,
  type SelectProduct,
  type SelectVariant,
  type SelectProductImage,
  type SelectBrand,
  type SelectCategory,
  type SelectGender,
  type SelectColor,
  type SelectSize,
} from "@/lib/db/schema";

import { NormalizedProductFilters } from "@/lib/utils/query";
import { sanitizeForQuery, sanitizePrice, sanitizeArrayInput } from "@/lib/utils/security";

type ProductListItem = {
  id: string;
  name: string;
  imageUrl: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  createdAt: Date;
  subtitle?: string | null;
};

export type GetAllProductsResult = {
  products: ProductListItem[];
  totalCount: number;
};

export async function getAllProducts(filters: NormalizedProductFilters): Promise<GetAllProductsResult> {
  // Sanitize all inputs to prevent injection
  const sanitizedFilters = {
    search: filters.search ? sanitizeForQuery(filters.search).slice(0, 100) : undefined,
    genderSlugs: sanitizeArrayInput(filters.genderSlugs).slice(0, 10),
    brandSlugs: sanitizeArrayInput(filters.brandSlugs).slice(0, 10),
    categorySlugs: sanitizeArrayInput(filters.categorySlugs).slice(0, 10),
    sizeSlugs: sanitizeArrayInput(filters.sizeSlugs).slice(0, 20),
    colorSlugs: sanitizeArrayInput(filters.colorSlugs).slice(0, 20),
    priceMin: sanitizePrice(filters.priceMin),
    priceMax: sanitizePrice(filters.priceMax),
    priceRanges: filters.priceRanges
      .map(([min, max]) => [sanitizePrice(min), sanitizePrice(max)])
      .filter(([min, max]) => min !== undefined || max !== undefined)
      .slice(0, 10), // Limit price ranges
    sort: filters.sort,
    page: Math.max(1, Math.min(filters.page, 100)), // Prevent pagination abuse
    limit: Math.max(1, Math.min(filters.limit, 60)), // Prevent large result sets
  };

  const conds: SQL[] = [eq(products.isPublished, true)];

  if (sanitizedFilters.search) {
    const pattern = `%${sanitizedFilters.search}%`;
    conds.push(or(ilike(products.name, pattern), ilike(products.description, pattern))!);
  }

  if (sanitizedFilters.genderSlugs.length) {
    conds.push(inArray(genders.slug, sanitizedFilters.genderSlugs));
  }

  if (sanitizedFilters.brandSlugs.length) {
    conds.push(inArray(brands.slug, sanitizedFilters.brandSlugs));
  }

  if (sanitizedFilters.categorySlugs.length) {
    conds.push(inArray(categories.slug, sanitizedFilters.categorySlugs));
  }

  const hasSize = sanitizedFilters.sizeSlugs.length > 0;
  const hasColor = sanitizedFilters.colorSlugs.length > 0;
  const hasPrice = !!(sanitizedFilters.priceMin !== undefined || sanitizedFilters.priceMax !== undefined || sanitizedFilters.priceRanges.length);

  const variantConds: SQL[] = [];
  if (hasSize) {
    variantConds.push(inArray(productVariants.sizeId, db
      .select({ id: sizes.id })
      .from(sizes)
      .where(inArray(sizes.slug, sanitizedFilters.sizeSlugs))));
  }
  if (hasColor) {
    variantConds.push(inArray(productVariants.colorId, db
      .select({ id: colors.id })
      .from(colors)
      .where(inArray(colors.slug, sanitizedFilters.colorSlugs))));
  }
  if (hasPrice) {
    const priceBounds: SQL[] = [];
    if (sanitizedFilters.priceRanges.length) {
      for (const [min, max] of sanitizedFilters.priceRanges) {
        const subConds: SQL[] = [];
        if (min !== undefined) {
          subConds.push(sql`CAST(${productVariants.price} AS DECIMAL) >= ${min}`);
        }
        if (max !== undefined) {
          subConds.push(sql`CAST(${productVariants.price} AS DECIMAL) <= ${max}`);
        }
        if (subConds.length) priceBounds.push(and(...subConds)!);
      }
    }
    if (sanitizedFilters.priceMin !== undefined || sanitizedFilters.priceMax !== undefined) {
      const subConds: SQL[] = [];
      if (sanitizedFilters.priceMin !== undefined) subConds.push(sql`CAST(${productVariants.price} AS DECIMAL) >= ${sanitizedFilters.priceMin}`);
      if (sanitizedFilters.priceMax !== undefined) subConds.push(sql`CAST(${productVariants.price} AS DECIMAL) <= ${sanitizedFilters.priceMax}`);
      if (subConds.length) priceBounds.push(and(...subConds)!);
    }
    if (priceBounds.length) {
      variantConds.push(or(...priceBounds)!);
    }
  }

  const variantJoin = db
    .select({
      variantId: productVariants.id,
      productId: productVariants.productId,
      price: sql<number | null>`CAST(${productVariants.price} AS DECIMAL)`.as("price"),
      colorId: productVariants.colorId,
      sizeId: productVariants.sizeId,
    })
    .from(productVariants)
    .where(variantConds.length ? and(...variantConds) : undefined)
    .as("v");
  const imagesJoin = hasColor
    ? db
        .select({
          productId: productImages.productId,
          url: productImages.url,
          rn: sql<number>`row_number() over (partition by ${productImages.productId} order by ${productImages.isPrimary} desc, ${productImages.sortOrder} asc)`.as("rn"),
        })
        .from(productImages)
        .innerJoin(productVariants, eq(productVariants.id, productImages.variantId))
        .where(
          inArray(
            productVariants.colorId,
            db.select({ id: colors.id }).from(colors).where(inArray(colors.slug, sanitizedFilters.colorSlugs))
          )
        )
        .as("pi")
    : db
        .select({
          productId: productImages.productId,
          url: productImages.url,
          rn: sql<number>`row_number() over (partition by ${productImages.productId} order by ${productImages.isPrimary} desc, ${productImages.sortOrder} asc)`.as("rn"),
        })
        .from(productImages)
        .where(isNull(productImages.variantId))
        .as("pi")


  const baseWhere = conds.length ? and(...conds) : undefined;

  const priceAgg = {
    minPrice: sql<number | null>`min(CAST(${variantJoin.price} AS DECIMAL))`,
    maxPrice: sql<number | null>`max(CAST(${variantJoin.price} AS DECIMAL))`,
  };

  const imageAgg = sql<string | null>`max(case when ${imagesJoin.rn} = 1 then ${imagesJoin.url} else null end)`;

  const primaryOrder =
    sanitizedFilters.sort === "price_asc"
      ? asc(sql`min(CAST(${variantJoin.price} AS DECIMAL))`)
      : sanitizedFilters.sort === "price_desc"
      ? desc(sql`max(CAST(${variantJoin.price} AS DECIMAL))`)
      : desc(products.createdAt);

  const page = Math.max(1, sanitizedFilters.page);
  const limit = Math.max(1, Math.min(sanitizedFilters.limit, 60));
  const offset = (page - 1) * limit;

  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      createdAt: products.createdAt,
      subtitle: genders.label,
      minPrice: priceAgg.minPrice,
      maxPrice: priceAgg.maxPrice,
      imageUrl: imageAgg,
    })
    .from(products)
    .leftJoin(variantJoin, eq(variantJoin.productId, products.id))
    .leftJoin(imagesJoin, eq(imagesJoin.productId, products.id))
    .leftJoin(genders, eq(genders.id, products.genderId))
    .leftJoin(brands, eq(brands.id, products.brandId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(baseWhere)
    .groupBy(products.id, products.name, products.createdAt, genders.label)
    .orderBy(primaryOrder, desc(products.createdAt), asc(products.id))
    .limit(limit)
    .offset(offset);
  const countRows = await db
    .select({
      cnt: count(sql<number>`distinct ${products.id}`),
    })
    .from(products)
    .leftJoin(variantJoin, eq(variantJoin.productId, products.id))
    .leftJoin(genders, eq(genders.id, products.genderId))
    .leftJoin(brands, eq(brands.id, products.brandId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(baseWhere);

  const productsOut: ProductListItem[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    imageUrl: r.imageUrl,
    minPrice: r.minPrice === null ? null : Number(r.minPrice),
    maxPrice: r.maxPrice === null ? null : Number(r.maxPrice),
    createdAt: r.createdAt,
    subtitle: r.subtitle ? `${r.subtitle} Shoes` : null,
  }));

  const totalCount = countRows[0]?.cnt ?? 0;

  return { products: productsOut, totalCount };
}

export type FullProduct = {
  product: SelectProduct & {
    brand?: SelectBrand | null;
    category?: SelectCategory | null;
    gender?: SelectGender | null;
  };
  variants: Array<
    SelectVariant & {
      color?: SelectColor | null;
      size?: SelectSize | null;
    }
  >;
  images: SelectProductImage[];
};

export async function getProduct(productId: string): Promise<FullProduct | null> {
  // Validate productId to prevent injection - Accept both UUID and numeric formats
  if (!productId || typeof productId !== 'string') {
    return null;
  }

  // Check if it's a UUID format
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(productId);
  
  // For security, ensure productId is properly formatted
  if (!isUUID) {
    // If it's not a UUID, it should be a valid identifier - for now we'll reject non-UUIDs
    // In a real app, you might want to support both formats
    return null;
  }

  const rows = await db
    .select({
      productId: products.id,
      productName: products.name,
      productDescription: products.description,
      productBrandId: products.brandId,
      productCategoryId: products.categoryId,
      productGenderId: products.genderId,
      isPublished: products.isPublished,
      defaultVariantId: products.defaultVariantId,
      productCreatedAt: products.createdAt,
      productUpdatedAt: products.updatedAt,

      brandId: brands.id,
      brandName: brands.name,
      brandSlug: brands.slug,
      brandLogoUrl: brands.logoUrl,

      categoryId: categories.id,
      categoryName: categories.name,
      categorySlug: categories.slug,

      genderId: genders.id,
      genderLabel: genders.label,
      genderSlug: genders.slug,

      variantId: productVariants.id,
      variantSku: productVariants.sku,
      variantPrice: sql<string | null>`COALESCE(${productVariants.price}::text, NULL)`.as("price"),
      variantSalePrice: sql<string | null>`COALESCE(${productVariants.salePrice}::text, NULL)`.as("sale_price"),
      variantColorId: productVariants.colorId,
      variantSizeId: productVariants.sizeId,
      variantInStock: productVariants.inStock,

      colorId: colors.id,
      colorName: colors.name,
      colorSlug: colors.slug,
      colorHex: colors.hexCode,

      sizeId: sizes.id,
      sizeName: sizes.name,
      sizeSlug: sizes.slug,
      sizeSortOrder: sizes.sortOrder,

      imageId: productImages.id,
      imageUrl: productImages.url,
      imageIsPrimary: productImages.isPrimary,
      imageSortOrder: productImages.sortOrder,
      imageVariantId: productImages.variantId,
    })
    .from(products)
    .leftJoin(brands, eq(brands.id, products.brandId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .leftJoin(genders, eq(genders.id, products.genderId))
    .leftJoin(productVariants, eq(productVariants.productId, products.id))
    .leftJoin(colors, eq(colors.id, productVariants.colorId))
    .leftJoin(sizes, eq(sizes.id, productVariants.sizeId))
    .leftJoin(productImages, eq(productImages.productId, products.id))
    .where(eq(products.id, productId));

  if (!rows.length) return null;

  const head = rows[0];

  const product: SelectProduct & {
    brand?: SelectBrand | null;
    category?: SelectCategory | null;
    gender?: SelectGender | null;
  } = {
    id: head.productId,
    name: head.productName,
    description: head.productDescription,
    brandId: head.productBrandId ?? null,
    categoryId: head.productCategoryId ?? null,
    genderId: head.productGenderId ?? null,
    isPublished: head.isPublished,
    defaultVariantId: head.defaultVariantId ?? null,
    createdAt: head.productCreatedAt,
    updatedAt: head.productUpdatedAt,
    brand: head.brandId
      ? {
          id: head.brandId,
          name: head.brandName!,
          slug: head.brandSlug!,
          logoUrl: head.brandLogoUrl ?? null,
        }
      : null,
    category: head.categoryId
      ? {
          id: head.categoryId,
          name: head.categoryName!,
          slug: head.categorySlug!,
          parentId: null,
        }
      : null,
    gender: head.genderId
      ? {
          id: head.genderId,
          label: head.genderLabel!,
          slug: head.genderSlug!,
        }
      : null,
  };

  const variantsMap = new Map<string, FullProduct["variants"][number]>();
  const imagesMap = new Map<string, SelectProductImage>();

  for (const r of rows) {
    if (r.variantId && !variantsMap.has(r.variantId)) {
      variantsMap.set(r.variantId, {
        id: r.variantId,
        productId: head.productId,
        sku: r.variantSku!,
        price: r.variantPrice || "0",
        salePrice: r.variantSalePrice || null,
        colorId: r.variantColorId!,
        sizeId: r.variantSizeId!,
        inStock: r.variantInStock!,
        weight: null,
        dimensions: null,
        createdAt: head.productCreatedAt,
        color: r.colorId
          ? {
              id: r.colorId,
              name: r.colorName!,
              slug: r.colorSlug!,
              hexCode: r.colorHex!,
            }
          : null,
        size: r.sizeId
          ? {
              id: r.sizeId,
              name: r.sizeName!,
              slug: r.sizeSlug!,
              sortOrder: r.sizeSortOrder!,
            }
          : null,
      });
    }
    if (r.imageId && !imagesMap.has(r.imageId)) {
      imagesMap.set(r.imageId, {
        id: r.imageId,
        productId: head.productId,
        variantId: r.imageVariantId ?? null,
        url: r.imageUrl!,
        sortOrder: r.imageSortOrder ?? 0,
        isPrimary: r.imageIsPrimary ?? false,
      });
    }
  }

  return {
    product,
    variants: Array.from(variantsMap.values()),
    images: Array.from(imagesMap.values()),
  };
}
export type Review = {
  id: string;
  author: string;
  rating: number;
  title?: string;
  content: string;
  createdAt: string;
};

export type RecommendedProduct = {
  id: string;
  title: string;
  price: number | null;
  imageUrl: string;
};

export async function getProductReviews(productId: string): Promise<Review[]> {
  // Validate productId to prevent injection - UUID format validation
  if (!productId || typeof productId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(productId)) {
    return [];
  }

  const rows = await db
    .select({
      id: reviews.id,
      rating: reviews.rating,
      comment: reviews.comment,
      createdAt: reviews.createdAt,
      authorName: users.name,
      authorEmail: users.email,
    })
    .from(reviews)
    .innerJoin(users, eq(users.id, reviews.userId))
    .where(eq(reviews.productId, productId))
    .orderBy(desc(reviews.createdAt))
    .limit(10);

  return rows.map((r) => ({
    id: r.id,
    author: r.authorName?.trim() || r.authorEmail || "Anonymous",
    rating: r.rating,
    title: undefined,
    content: r.comment || "",
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function getRecommendedProducts(productId: string): Promise<RecommendedProduct[]> {
  // Validate productId to prevent injection - UUID format validation
  if (!productId || typeof productId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(productId)) {
    return [];
  }

  const base = await db
    .select({
      id: products.id,
      categoryId: products.categoryId,
      brandId: products.brandId,
      genderId: products.genderId,
    })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!base.length) return [];
  const b = base[0];

  const v = db
    .select({
      productId: productVariants.productId,
      price: sql<number>`CAST(${productVariants.price} AS DECIMAL)`.as("price"),
    })
    .from(productVariants)
    .as("v");

  const pi = db
    .select({
      productId: productImages.productId,
      url: productImages.url,
      rn: sql<number>`row_number() over (partition by ${productImages.productId} order by ${productImages.isPrimary} desc, ${productImages.sortOrder} asc)`.as(
        "rn",
      ),
    })
    .from(productImages)
    .as("pi");

  const priority = sql<number>`
    (case when ${products.categoryId} is not null and ${products.categoryId} = ${b.categoryId} then 1 else 0 end) * 3 +
    (case when ${products.brandId} is not null and ${products.brandId} = ${b.brandId} then 1 else 0 end) * 2 +
    (case when ${products.genderId} is not null and ${products.genderId} = ${b.genderId} then 1 else 0 end) * 1
  `;

  const rows = await db
    .select({
      id: products.id,
      title: products.name,
      minPrice: sql<number | null>`min(CAST(${v.price} AS DECIMAL))`,
      imageUrl: sql<string | null>`max(case when ${pi.rn} = 1 then ${pi.url} else null end)`,
      createdAt: products.createdAt,
    })
    .from(products)
    .leftJoin(v, eq(v.productId, products.id))
    .leftJoin(pi, eq(pi.productId, products.id))
    .where(and(eq(products.isPublished, true), sql`${products.id} <> ${productId}`))
    .groupBy(products.id, products.name, products.createdAt)
    .orderBy(
      desc(priority),
      desc(products.createdAt),
      asc(products.id)
    )
    .limit(8);

  const out: RecommendedProduct[] = [];
  for (const r of rows) {
    const img = r.imageUrl?.trim();
    if (!img) continue;
    out.push({
      id: r.id,
      title: r.title,
      price: r.minPrice === null ? null : Number(r.minPrice),
      imageUrl: img,
    });
    if (out.length >= 6) break;
  }
  return out;
}