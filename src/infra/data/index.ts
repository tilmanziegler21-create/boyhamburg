import { useSheets } from "../config";
import { Product, Courier, User } from "../../core/types";
import {
  getProducts as sheetsGetProducts,
  updateProductQty as sheetsUpdateProductQty,
  updateProductPrice as sheetsUpdateProductPrice,
  getCouriers as sheetsGetCouriers,
  updateCourier as sheetsUpdateCourier,
  getUsers as sheetsGetUsers,
  addUser as sheetsAddUser,
  updateUser as sheetsUpdateUser
} from "../sheets/SheetsClient";
import {
  getProducts as mockGetProducts,
  updateProductQty as mockUpdateProductQty,
  updateProductPrice as mockUpdateProductPrice,
  getCouriers as mockGetCouriers,
  updateCourier as mockUpdateCourier,
  getUsers as mockGetUsers,
  addUser as mockAddUser,
  updateUser as mockUpdateUser
} from "./mock/MockData";

export async function getProducts(): Promise<Product[]> {
  return useSheets ? sheetsGetProducts() : mockGetProducts();
}

export async function refreshProductsCache(): Promise<Product[]> {
  return getProducts();
}

export async function updateProductQty(product_id: number, new_qty: number): Promise<void> {
  return useSheets ? sheetsUpdateProductQty(product_id, new_qty) : mockUpdateProductQty(product_id, new_qty);
}

export async function updateProductPrice(product_id: number, new_price: number): Promise<void> {
  return useSheets ? sheetsUpdateProductPrice(product_id, new_price) : mockUpdateProductPrice(product_id, new_price);
}

export async function getCouriers(): Promise<Courier[]> {
  return useSheets ? sheetsGetCouriers() : mockGetCouriers();
}

export async function updateCourier(courier_id: number, fields: Partial<Courier>): Promise<void> {
  return useSheets ? sheetsUpdateCourier(courier_id, fields) : mockUpdateCourier(courier_id, fields);
}

export async function getUsers(): Promise<User[]> {
  return useSheets ? sheetsGetUsers() : mockGetUsers();
}

export async function addUser(user: User): Promise<void> {
  return useSheets ? sheetsAddUser(user) : mockAddUser(user);
}

export async function updateUser(user_id: number, fields: Partial<User>): Promise<void> {
  return useSheets ? sheetsUpdateUser(user_id, fields) : mockUpdateUser(user_id, fields);
}
