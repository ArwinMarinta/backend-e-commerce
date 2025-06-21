const express = require("express");
const bcrypt = require("bcrypt");
const app = express();
const db = require("./prisma/connection");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const imagekit = require("./imagekit");
const multer = require("multer");

app.use(express.json());
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
const upload = multer();

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) {
    return res.status(401).json({ message: "Token is required" });
  }

  const token = authHeader.split(" ")[1];

  jwt.verify(token, "papb_bisdig", (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

app.post("/register", async (req, res) => {
  const { name, email, password } = req.body;

  const existingUser = await db.user.findUnique({ where: { email } });
  if (existingUser) {
    return res.status(400).json({ message: "Email already in use" });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const user = await db.user.create({
    data: {
      name,
      email,
      password: hashedPassword,
    },
  });

  res.status(201).json({ message: "User registered", user: { id: user.id, name: user.name, email: user.email } });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    return res.status(400).json({ message: "Invalid email or password" });
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return res.status(400).json({ message: "Invalid email or password" });
  }

  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
    },
    "papb_bisdig"
  );

  res.json({
    message: "Login successful",
    token,
    user: { id: user.id, name: user.name, email: user.email },
  });
});

app.post("/products", upload.single("image"), async (req, res) => {
  try {
    const { name, description, price, stock, category } = req.body;

    let imageUrl = null;

    if (req.file) {
      const uploadResponse = await imagekit.upload({
        file: req.file.buffer,
        fileName: req.file.originalname,
        folder: "/",
      });
      imageUrl = uploadResponse.url;
    }

    const product = await db.product.create({
      data: {
        name,
        description,
        price: parseFloat(price),
        stock: parseInt(stock),
        category,
        imageUrl,
      },
    });

    res.status(201).json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Gagal menambahkan produk." });
  }
});

app.get("/products", async (req, res) => {
  const search = req.query.search; // ambil query search dari URL

  try {
    const products = await db.product.findMany({
      where: search
        ? {
            name: {
              contains: search,
            },
          }
        : undefined,
      orderBy: { createdAt: "desc" },
    });

    res.json({ message: "Berhasil", data: products });
  } catch (err) {
    console.error("Gagal mengambil data produk:", err);
    res.status(500).json({ message: "Gagal mengambil data produk." });
  }
});

app.delete("/products/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Pastikan produk ada
    const product = await db.product.findUnique({
      where: { id: parseInt(id) },
    });

    if (!product) {
      return res.status(404).json({ message: "Produk tidak ditemukan." });
    }

    await db.cartItem.deleteMany({
      where: {
        productId: parseInt(id),
      },
    });

    // Baru hapus produk
    await db.product.delete({
      where: { id: parseInt(id) },
    });

    res.json({ message: "Produk berhasil dihapus." });
  } catch (err) {
    console.error("Gagal menghapus produk:", err);
    res.status(500).json({ message: "Gagal menghapus produk." });
  }
});

app.post("/cart/add", authenticateToken, async (req, res) => {
  const { productId, quantity } = req.body;
  const userId = req.user.id;

  try {
    let cart = await db.cart.findFirst({
      where: { userId },
    });

    if (!cart) {
      cart = await db.cart.create({
        data: { userId },
      });
    }

    // Cek apakah produk sudah ada di keranjang
    const existingItem = await db.cartItem.findFirst({
      where: {
        cartId: cart.id,
        productId,
      },
    });

    if (existingItem) {
      // Produk sudah ada, update quantity
      await db.cartItem.update({
        where: { id: existingItem.id },
        data: {
          quantity: existingItem.quantity + quantity,
        },
      });
    } else {
      // Produk belum ada, tambahkan baru
      await db.cartItem.create({
        data: {
          cartId: cart.id,
          productId,
          quantity,
        },
      });
    }

    res.json({ message: "Produk berhasil ditambahkan ke keranjang." });
  } catch (err) {
    console.error("Gagal menambahkan produk ke keranjang:", err);
    res.status(500).json({ message: "Gagal menambahkan produk ke keranjang." });
  }
});

app.get("/cart", authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const cart = await db.cart.findFirst({
      where: { userId },
    });

    if (!cart) {
      return res.json([]); // Kosong, belum punya keranjang
    }

    const items = await db.cartItem.findMany({
      where: { cartId: cart.id },
      include: {
        product: true, // Ambil detail produk
      },
    });

    res.json({ message: "Berhasil", data: items });
  } catch (err) {
    console.error("Gagal mengambil keranjang:", err);
    res.status(500).json({ message: "Gagal mengambil keranjang." });
  }
});

app.delete("/cart/remove/:productId", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const productId = parseInt(req.params.productId);

  console.log(productId);

  try {
    const cart = await db.cart.findFirst({
      where: { userId },
    });

    if (!cart) {
      return res.status(404).json({ message: "Keranjang tidak ditemukan." });
    }

    const cartItem = await db.cartItem.findFirst({
      where: {
        cartId: cart.id,
        id: productId,
      },
    });

    if (!cartItem) {
      return res.status(404).json({ message: "Produk tidak ada di keranjang." });
    }

    await db.cartItem.delete({
      where: { id: cartItem.id },
    });

    res.json({ message: "Produk berhasil dihapus dari keranjang." });
  } catch (err) {
    console.error("Gagal menghapus produk dari keranjang:", err);
    res.status(500).json({ message: "Gagal menghapus produk dari keranjang." });
  }
});

app.get("/test", async (req, res) => {
  return res.status(200).send("Connect Success");
});

app.listen(3000, () => {
  console.log("Server berjalan di http://localhost:3000");
});
