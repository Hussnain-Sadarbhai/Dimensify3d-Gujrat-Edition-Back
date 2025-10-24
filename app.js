const express = require("express");
const app = express();
const port = 2026;
const multer = require("multer");
const admin = require("./db/firebase").firebaseAdmin;
const cors = require("cors");
//const { v4: uuidv4 } = require('uuid');
const Razorpay = require("razorpay");
const crypto = require("crypto");





app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));





// Firestore and Realtime Database setup
const db = admin.database();
const bucket = admin.storage().bucket();


const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      // STL
      'application/sla',
      'application/octet-stream',
      'model/stl',

      // Images
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif'
    ];

    const allowedExtensions = ['.stl', '.jpg', '.jpeg', '.png', '.webp', '.gif'];

    const fileExt = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));

    if (allowedMimes.includes(file.mimetype) || allowedExtensions.includes(fileExt)) {
      cb(null, true);
    } else {
      cb(new Error('Only STL files and images (jpg, png, webp, gif) are allowed'), false);
    }
  }
});


// Root route
app.get("/", (req, res) => {
  res.send("Backend Started!");
});

//help section
// POST API endpoint for help form submission
app.post('/api/help-request', upload.single('screenshot'), async (req, res) => {
  try {
    const { name, phone, email, concern } = req.body;
    
    // Validate required fields
    if (!name || !phone || !concern) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: name, phone, and concern are required'
      });
    }

    // Validate phone number format (basic validation)
    const phoneRegex = /^[\+]?[1-9][\d]{0,15}$/;
    if (!phoneRegex.test(phone.replace(/\s/g, ''))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number format'
      });
    }

    // Validate email if provided
    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format'
        });
      }
    }

    // Generate unique request ID
    const requestId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9);
    let screenshotUrl = null;

    // Handle screenshot upload if provided
    if (req.file) {
      try {
        const fileName = `help-screenshots/${requestId}_${Date.now()}_${req.file.originalname}`;
        const file = bucket.file(fileName);
        
        // Upload file to Firebase Storage
        await file.save(req.file.buffer, {
          metadata: {
            contentType: req.file.mimetype,
            metadata: {
              uploadedBy: 'help-form',
              requestId: requestId,
              originalName: req.file.originalname
            }
          }
        });

        // Make the file publicly accessible
        await file.makePublic();

        // Get the public URL
        screenshotUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
        
        console.log(`Screenshot uploaded successfully: ${screenshotUrl}`);
      } catch (uploadError) {
        console.error('Screenshot upload error:', uploadError);
        return res.status(500).json({
          success: false,
          message: 'Failed to upload screenshot',
          error: uploadError.message
        });
      }
    }

    // Prepare data for Firebase Realtime Database
    const helpRequestData = {
      requestId: requestId,
      name: name.trim(),
      phone: phone.trim(),
      email: email ? email.trim() : null,
      concern: concern.trim(),
      screenshotUrl: screenshotUrl,
      status: 'pending',
      priority: 'normal',
      createdAt: admin.database.ServerValue.TIMESTAMP,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
      metadata: {
        userAgent: req.get('User-Agent'),
        ip: req.ip || req.connection.remoteAddress,
        source: 'help-form'
      }
    };

    // Save to Firebase Realtime Database
    const helpRequestsRef = db.ref('helpRequests');
    await helpRequestsRef.child(requestId).set(helpRequestData);

    console.log(`Help request saved successfully: ${requestId}`);

    // Send success response
    res.status(201).json({
      success: true,
      message: 'Help request submitted successfully',
      data: {
        requestId: requestId,
        status: 'pending',
        submittedAt: new Date().toISOString()
      }
    });

    // Optional: Send notification (you can add email/SMS notification here)
    // await sendNotificationToSupport(helpRequestData);

  } catch (error) {
    console.error('Error submitting help request:', error);
    
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
});

// GET all help requests
app.get("/api/help-request", async (req, res) => {
  try {
    const helpRequestsRef = db.ref("helpRequests");
    const snapshot = await helpRequestsRef.once("value");
    const requests = snapshot.val() || {};
    return res.json({
      success: true,
      data: requests,
    });
  } catch (error) {
    console.error("Error fetching help requests:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// GET single help request by ID
app.get("/api/help-request/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const helpRequestsRef = db.ref("helpRequests").child(id);

    const snapshot = await helpRequestsRef.once("value");
    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: "Help request not found",
      });
    }

    return res.json({
      success: true,
      data: snapshot.val(),
    });
  } catch (error) {
    console.error("Error fetching help request:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// PUT API - update help request status
app.put("/api/help-request/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // Allow only resolved or rejected
    if (!["resolved", "rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status. Allowed: resolved, rejected",
      });
    }

    const helpRequestRef = db.ref("helpRequests").child(id);

    const snapshot = await helpRequestRef.once("value");
    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: "Help request not found",
      });
    }

    await helpRequestRef.update({
      status,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });

    return res.json({
      success: true,
      message: `Help request ${id} updated to ${status}`,
    });
  } catch (error) {
    console.error("Error updating help request:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});



// GET API to fetch admin credentials
app.get('/api/admin-credentials', async (req, res) => {
  try {
    const ref = db.ref('AdminCredentialss'); // reference to AdminCredentialss node
    const snapshot = await ref.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: 'Admin credentials not found'
      });
    }

    const data = snapshot.val();

    res.status(200).json({
      success: true,
      message: 'Admin credentials fetched successfully',
      data: data
    });

  } catch (error) {
    console.error('Error fetching admin credentials:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
});

// signup and login apis for user
app.post('/api/signup', async (req, res) => {
  try {
    const { name, phone, email, password } = req.body;
    
    // Validate required fields
    if (!name || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: name, phone, and password are required'
      });
    }

    // Validate name length
    if (name.trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: 'Name must be at least 2 characters long'
      });
    }

    // Validate phone number format (10 digits)
    const phoneDigits = phone.replace(/\D/g, '');
    if (!/^\d{10}$/.test(phoneDigits)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid 10-digit phone number'
      });
    }

    // Validate email if provided
    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format'
        });
      }
    }

    // Validate password length
    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters long'
      });
    }

    // Check if user already exists with this phone number
    const existingUserSnapshot = await db.ref('users')
      .orderByChild('phone')
      .equalTo(phoneDigits)
      .once('value');

    if (existingUserSnapshot.exists()) {
      return res.status(400).json({
        success: false,
        message: 'User with this phone number already exists'
      });
    }

    // Generate unique user ID
    const userId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9);

    // Prepare data for Firebase Realtime Database (now includes password as it is)
    const userData = {
      userId: userId,
      name: name.trim(),
      phone: phoneDigits,
      email: email ? email.trim() : null,
      password: password,   // 🔴 storing as plain text
      status: 'active',
      createdAt: admin.database.ServerValue.TIMESTAMP,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    };

    // Save to Firebase Realtime Database
    const usersRef = db.ref('users');
    await usersRef.child(userId).set(userData);

    console.log(`User created successfully: ${userId}`);

    // Send success response (don't send sensitive data back)
    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      data: {
        userId: userId,
        name: userData.name,
        phone: userData.phone,
        email: userData.email,
        status: userData.status,
        createdAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error creating user account:', error);
    
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    // Reference to users node
    const usersRef = db.ref('users');
    const snapshot = await usersRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: 'No users found'
      });
    }

    const usersData = snapshot.val();

    // Convert object to array
    const usersArray = Object.values(usersData);

    res.status(200).json({
      success: true,
      count: usersArray.length,
      data: usersArray
    });

  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
});

// Get specific user by phone number
app.post('/api/user-by-phone', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required"
      });
    }

    // Reference to users node
    const usersRef = db.ref('users');
    const snapshot = await usersRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: "No users found"
      });
    }

    const usersData = snapshot.val();

    // 🔍 Find user by phone number
    const user = Object.values(usersData).find(u => u.phone === phone);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: `User with phone ${phone} not found`
      });
    }

    res.status(200).json({
      success: true,
      data: user
    });

  } catch (error) {
    console.error("Error fetching user:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: process.env.NODE_ENV === "development" ? error.message : "Something went wrong"
    });
  }
});

//consaltancy apis
// POST API: Save consultancy details
app.post("/api/consultancy", async (req, res) => {
  try {
    const { phone, problem, date, photo } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required to identify user",
      });
    }

    const usersRef = db.ref("users");
    const snapshot = await usersRef.once("value");

    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: "No users found",
      });
    }

    let userId = null;
    snapshot.forEach((child) => {
      if (child.val().phone === phone) {
        userId = child.key;
      }
    });

    if (!userId) {
      return res.status(404).json({
        success: false,
        message: "User not found with given phone number",
      });
    }

    const consultancyData = {
      problem: problem || "",
      date,
      createdAt: Date.now(),
    };

    if (photo) {
      const buffer = Buffer.from(photo, "base64");
      const fileName = `consultancy/${userId}/${Date.now()}.jpg`;
      const file = bucket.file(fileName);

      await file.save(buffer, { metadata: { contentType: "image/jpeg" } });

      const [url] = await file.getSignedUrl({
        action: "read",
        expires: "03-09-2099",
      });

      consultancyData.photoUrl = url;
    }

    await db.ref(`users/${userId}/consultancy`).push(consultancyData);

    res.status(201).json({
      success: true,
      message: "Consultancy appointment saved successfully",
      data: consultancyData,
    });
  } catch (error) {
    console.error("Error saving consultancy:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Something went wrong",
    });
  }
});

// Get all consultancy requests
app.get("/api/consultancy-requests", async (req, res) => {
  try {
    const usersRef = db.ref("users");
    const snapshot = await usersRef.once("value");

    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: "No users found",
      });
    }

    const usersData = snapshot.val();
    let allRequests = [];

    Object.values(usersData).forEach((user) => {
      if (user.consultancy) {
        Object.entries(user.consultancy).forEach(([consultancyId, req]) => {
          if (req.status !== "attended") { // only show pending
            allRequests.push({
              ...req,
              consultancyId,
              userId: user.userId,
              userName: user.name,
              userPhone: user.phone,
              createdAt: req.createdAt || Date.now(),
            });
          }
        });
      }
    });

    // Sort oldest first
    allRequests.sort((a, b) => a.createdAt - b.createdAt);

    res.status(200).json({
      success: true,
      count: allRequests.length,
      data: allRequests,
    });
  } catch (error) {
    console.error("Error fetching consultancy requests:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});


// Update consultancy request status
app.put("/api/users/:userId/consultancy/:consultancyId/status", async (req, res) => {
  try {
    const { userId, consultancyId } = req.params;
    const { status } = req.body;

    const ref = db.ref(`users/${userId}/consultancy/${consultancyId}/status`);
    await ref.set(status);

    res.status(200).json({
      success: true,
      message: "Status updated successfully",
    });
  } catch (error) {
    console.error("Error updating status:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

//Coupons Apis
//Add Copuons
app.post("/api/coupons", async (req, res) => {
  try {
    const { name, discount, expiry, limit, public: isPublic = true } = req.body;

    if (!name || !discount || !expiry || !limit) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    // create unique ID for each coupon
    const couponRef = db.ref("coupons").push();

    const newCoupon = {
      id: couponRef.key,
      name,
      discount,
      expiry,
      limit,
      public: !!isPublic, // ✅ store true/false
      createdAt: Date.now(),
    };

    await couponRef.set(newCoupon);

    res.status(201).json({
      success: true,
      message: "Coupon created successfully",
      data: newCoupon,
    });
  } catch (error) {
    console.error("Error creating coupon:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});


// ✅ GET API to fetch all coupons
app.get("/api/coupons", async (req, res) => {
  try {
    const snapshot = await db.ref("coupons").once("value");

    if (!snapshot.exists()) {
      return res.status(200).json({
        success: true,
        message: "No coupons found",
        data: [],
      });
    }

    const coupons = Object.values(snapshot.val()); // convert object -> array

    res.status(200).json({
      success: true,
      data: coupons,
    });
  } catch (error) {
    console.error("Error fetching coupons:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});

//Address apis
app.post("/api/users/:phone/address", async (req, res) => {
  try {
    const { phone } = req.params;
    const { street, addressLine2, landmark, city, state, pincode, name } = req.body;

    if (!street || !city || !state || !pincode) {
      return res.status(400).json({ success: false, message: "All required fields must be filled" });
    }

    // 1️⃣ Get reference to all users
    const usersRef = db.ref("users");
    const snapshot = await usersRef.once("value");

    if (!snapshot.exists()) {
      return res.status(404).json({ success: false, message: "No users found" });
    }

    const usersData = snapshot.val();

    // 2️⃣ Find the user key by phone
    const userKey = Object.keys(usersData).find(key => usersData[key].phone === phone);

    if (!userKey) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // 3️⃣ Reference to the addresses subnode of this user
    const addressRef = db.ref(`users/${userKey}/addresses`).push();

    // 4️⃣ Save the new address
    await addressRef.set({
      name: name || usersData[userKey].name || "",
      addressLine1: street,
      addressLine2: addressLine2 || "",
      landmark: landmark || "",
      city,
      state,
      pincode,
      createdAt: Date.now(),
    });

    return res.json({ success: true, message: "Address added successfully" });
  } catch (error) {
    console.error("Error saving address:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

//update address
app.put("/api/users/:phone", async (req, res) => {
  try {
    const { phone } = req.params;
    const updatedData = req.body; // can include fields like name, email, etc.

    if (!phone) {
      return res.status(400).json({ success: false, message: "Phone number is required" });
    }

    // 1️⃣ Get reference to all users
    const usersRef = db.ref("users");
    const snapshot = await usersRef.once("value");

    if (!snapshot.exists()) {
      return res.status(404).json({ success: false, message: "No users found" });
    }

    const usersData = snapshot.val();

    // 2️⃣ Find the user key by phone
    const userKey = Object.keys(usersData).find(key => usersData[key].phone === phone);

    if (!userKey) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // 3️⃣ Update the user data
    const userRef = db.ref(`users/${userKey}`);
    await userRef.update({
      ...updatedData,
      updatedAt: Date.now(),
    });

    return res.json({ success: true, message: "User data updated successfully" });
  } catch (error) {
    console.error("Error updating user:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});



//Order Apis getting multiple stl files order
app.post("/api/orders", upload.any(), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: "At least one STL file is required" });
    }

    // Parse orderData from FormData (it's a string)
    const orderData = JSON.parse(req.body.orderData);

    if (!orderData.phone) {
      return res.status(400).json({ success: false, message: "Phone number is required" });
    }

    // 1️⃣ Find user by phone
    const usersSnapshot = await db
      .ref("users")
      .orderByChild("phone")
      .equalTo(orderData.phone)
      .once("value");

    const users = usersSnapshot.val();

    if (!users) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const userId = Object.keys(users)[0];

    // 2️⃣ Upload all STL files to Storage
    const uploadedFiles = [];
    
    for (let i = 0; i < req.files.length; i++) {
      const stlFile = req.files[i];
      
      // Create unique filename with timestamp to avoid conflicts
      const timestamp = Date.now();
      const fileName = `orders/${orderData.phone}/${timestamp}_${stlFile.originalname}`;
      const file = bucket.file(fileName);
      
      await file.save(stlFile.buffer, { 
        contentType: stlFile.mimetype || 'application/octet-stream' 
      });

      uploadedFiles.push({
        originalName: stlFile.originalname,
        fileName: fileName,
        fileUrl: `gs://${bucket.name}/${fileName}`,
        size: stlFile.size,
        fieldName: stlFile.fieldname
      });
    }

    // 3️⃣ Add uploaded files info to orderData
    orderData.uploadedFiles = uploadedFiles;
    orderData.fileCount = req.files.length;

    // For backward compatibility, if there's only one file, also set the old stlFileUrl
    if (req.files.length === 1) {
      orderData.stlFileUrl = uploadedFiles[0].fileUrl;
    }

    // 4️⃣ Add default status and timestamp
    orderData.status = "pending";
    orderData.uploadTimestamp = new Date().toISOString();

    // 5️⃣ Push order to existing user's orders
    const orderRef = db.ref(`users/${userId}/orders`).push();
    await orderRef.set(orderData);

    res.json({ 
      success: true, 
      message: `Order with ${req.files.length} file(s) stored successfully!`,
      orderData: {
        orderId: orderRef.key,
        fileCount: req.files.length,
        uploadedFiles: uploadedFiles.map(file => ({
          name: file.originalName,
          size: file.size
        }))
      }
    });

  } catch (err) {
    console.error("Error storing order:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

//payment gateway apis
// 🔑 Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_APP_ID,
  key_secret: process.env.RAZORPAY_SECRET_KEY,
});

// 1️⃣ Create Order API
app.post("/api/createOrder", async (req, res) => {
  try {
    const { amount, currency = "INR", receipt } = req.body;

    if (!amount) {
      return res.status(400).json({ success: false, message: "Amount is required" });
    }

    const options = {
      amount: amount * 100, // amount in paise
      currency,
      receipt: receipt || "receipt_" + Date.now(),
    };

    const order = await razorpay.orders.create(options);

    res.json({ success: true, order });
  } catch (err) {
    console.error("Error creating Razorpay order:", err);
    res.status(500).json({ success: false, message: "Failed to create order" });
  }
});

// 2️⃣ Verify Payment API
app.post("/api/verifyOrder", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Invalid payment data" });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_SECRET_KEY)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature === razorpay_signature) {
      res.json({ success: true, message: "Payment verified successfully!" });
    } else {
      res.status(400).json({ success: false, message: "Invalid signature" });
    }
  } catch (err) {
    console.error("Error verifying Razorpay payment:", err);
    res.status(500).json({ success: false, message: "Payment verification failed" });
  }
});


//api online stores
// POST API to add online product
app.post("/api/products", upload.array("images", 3), async (req, res) => {
  try {
    const { modelName, price, off, finalPrice, description, customizeQuestion, category } = req.body;

    // Validation - now includes category
    if (!modelName || !price || !finalPrice || !category) {
      return res.status(400).json({
        success: false,
        message: "Model name, category, price, and final price are required",
      });
    }

    // ✅ Create new product ref in DB
    const productRef = db.ref("products").push();

    // 📂 Upload images to Firebase Storage
    let imageUrls = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const fileName = `products/${productRef.key}/${Date.now()}-${file.originalname}`;
        const fileUpload = bucket.file(fileName);

        await fileUpload.save(file.buffer, {
          metadata: { contentType: file.mimetype },
        });

        // Get public download URL
        const [url] = await fileUpload.getSignedUrl({
          action: "read",
          expires: "03-01-2035",
        });

        imageUrls.push(url);
      }
    }

    const newProduct = {
      id: productRef.key,
      modelName,
      category,
      price: parseFloat(price),
      off: parseFloat(off) || 0,
      finalPrice: parseFloat(finalPrice),
      description: description || "",
      customizeQuestion: customizeQuestion || "", // Added this line
      images: imageUrls,
      createdAt: Date.now(),
    };

    await productRef.set(newProduct);

    res.status(201).json({
      success: true,
      message: "Product created successfully",
      data: newProduct,
    });
  } catch (error) {
    console.error("Error creating product:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});


// Get all products
app.get("/api/get-products", async (req, res) => {
  try {
    const snapshot = await db.ref("products").once("value");

    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: "No products found",
      });
    }

    const products = snapshot.val();
    const productList = Object.values(products);

    res.status(200).json({
      success: true,
      data: productList,
    });
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});

//Update products
app.put("/api/products/:id", upload.array("images"), async (req, res) => {
  try {
    const { id } = req.params;

    // Parse JSON fields from FormData
    const {
      modelName,
      price,
      off,
      finalPrice,
      description,
      customizeQuestion,
      category,
      existingImages
    } = req.body;

    const parsedExistingImages = existingImages
      ? JSON.parse(existingImages)
      : [];

    const newImageUrls = [];

    // Upload new images to Firebase Storage
    for (const file of req.files) {
      const fileName = `products/${Date.now()}_${file.originalname}`;
      const fileRef = bucket.file(fileName);

      await fileRef.save(file.buffer, {
        metadata: { contentType: file.mimetype }
      });

      const [url] = await fileRef.getSignedUrl({
        action: "read",
        expires: "03-09-2030"
      });

      newImageUrls.push(url);
    }

    // Merge existing and new image URLs
    const allImages = [...parsedExistingImages, ...newImageUrls];

    // Update the Realtime Database product
    await db.ref(`products/${id}`).update({
      modelName,
      price: parseFloat(price),
      off: parseFloat(off),
      finalPrice: parseFloat(finalPrice),
      description: description || "",
      customizeQuestion: customizeQuestion || "",
      category,
      images: allImages,
      updatedAt: Date.now()
    });

    // Fetch updated product
    const updatedSnapshot = await db.ref(`products/${id}`).once("value");
    res.status(200).json({
      success: true,
      message: "Product updated successfully",
      data: updatedSnapshot.val()
    });
  } catch (error) {
    console.error("Error updating product:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

//Delete api
app.delete("/api/products/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Check if product exists
    const productSnapshot = await db.ref(`products/${id}`).once("value");
    
    if (!productSnapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const product = productSnapshot.val();
    console.log("Product found:", product.id);

    // Delete images from Firebase Storage
    if (product.images && product.images.length > 0) {
      const admin = require('firebase-admin');
      const bucket = admin.storage().bucket();
      
      console.log(`Attempting to delete ${product.images.length} images for product ${id}`);
      
      for (const imageUrl of product.images) {
        try {
          console.log("Processing image URL:", imageUrl);
          
          // Extract file path from the URL - your exact format
          // URL: https://storage.googleapis.com/dimensify3d-12740.firebasestorage.app/products/-O_uYV2QX4LJ8nAvrC2y/1758697734914-Screenshot%20%28576%29.png?GoogleAccessId=...
          const url = new URL(imageUrl);
          const pathname = url.pathname;
          
          // Pathname format: /products/-O_uYV2QX4LJ8nAvrC2y/1758697734914-Screenshot%20%28576%29.png
          // Remove the leading slash and decode URI components
          let filePath = pathname.substring(1); // Remove leading slash
          filePath = decodeURIComponent(filePath); // Convert %20 to spaces, etc.
          
          console.log(`Extracted file path: ${filePath}`);
          
          if (filePath) {
            const file = bucket.file(filePath);
            
            // Check if file exists before deleting
            const [exists] = await file.exists();
            if (exists) {
              await file.delete();
              console.log(`✅ Successfully deleted image: ${filePath}`);
            } else {
              console.warn(`⚠️ Image file does not exist in storage: ${filePath}`);
            }
          } else {
            console.warn(`❌ Could not extract file path from URL: ${imageUrl}`);
          }
        } catch (imgError) {
          console.error("❌ Error deleting image:", imgError.message);
          // Continue with product deletion even if image deletion fails
        }
      }
    } else {
      console.log("No images found for this product");
    }

    // Also delete the entire product folder as a backup
    try {
      const admin = require('firebase-admin');
      const bucket = admin.storage().bucket();
      
      // Delete all files in the product folder
      const [files] = await bucket.getFiles({
        prefix: `products/${id}/`
      });
      
      if (files.length > 0) {
        console.log(`Found ${files.length} files in products/${id}/ folder, deleting...`);
        await Promise.all(files.map(file => {
          console.log(`Deleting file: ${file.name}`);
          return file.delete();
        }));
        console.log(`✅ Successfully deleted all files from products/${id}/ folder`);
      } else {
        console.log(`No files found in products/${id}/ folder`);
      }
    } catch (folderError) {
      console.error("Error deleting product folder:", folderError);
    }

    // Delete the product from database
    await db.ref(`products/${id}`).remove();
    console.log(`✅ Product ${id} deleted from database`);

    res.status(200).json({
      success: true,
      message: "Product and associated images deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting product:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});

//stl file download
// Proxy download endpoint to avoid CORS issues
app.post('/api/download-file-proxy', async (req, res) => {
  try {
    const { filePath, fileName } = req.body;
    
    if (!filePath) {
      return res.status(400).json({
        success: false,
        message: 'File path is required'
      });
    }

    // Handle gs:// URLs
    let storagePath = filePath;
    if (filePath.startsWith('gs://')) {
      storagePath = filePath.replace('gs://dimensify3d-12740.firebasestorage.app/', '');
    }

    console.log('Attempting to download file:', storagePath);
    
    // Get Firebase Storage bucket
    const bucket = admin.storage().bucket('dimensify3d-12740.firebasestorage.app');
    const file = bucket.file(storagePath);

    // Check if file exists
    const [exists] = await file.exists();
    if (!exists) {
      console.log('File does not exist:', storagePath);
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    // Get file metadata
    const [metadata] = await file.getMetadata();
    
    // Extract filename if not provided
    const downloadFileName = fileName || storagePath.split('/').pop() || 'download.stl';
    
    // Set appropriate headers for download
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${downloadFileName}"`,
      'Content-Length': metadata.size,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type'
    });

    console.log('Starting file stream for:', downloadFileName);

    // Stream the file directly to response
    const stream = file.createReadStream();
    
    stream.on('error', (error) => {
      console.error('Stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: 'Error streaming file',
          error: error.message
        });
      }
    });

    stream.on('end', () => {
      console.log('File stream completed successfully');
    });

    // Pipe the file stream to the response
    stream.pipe(res);

  } catch (error) {
    console.error('Download proxy error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Error downloading file',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
      });
    }
  }
});


// PUT API to update order status
app.put('/api/orders/:orderId/status', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status, userId } = req.body;

    // Validate required fields
    if (!status) {
      return res.status(400).json({
        success: false,
        message: 'Status is required'
      });
    }

    // Validate status values
    const validStatuses = ['pending', 'processing', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be one of: pending, processing, completed, cancelled'
      });
    }

    let orderFound = false;
    let updatedUserKey = null;
    let updatedOrderKey = null;

    // If userId is provided, update directly
    if (userId) {
      const userRef = db.ref(`users/${userId}/orders`);
      const userSnapshot = await userRef.once('value');
      
      if (userSnapshot.exists()) {
        const orders = userSnapshot.val();
        const orderKey = Object.keys(orders).find(key => orders[key].orderId === orderId);
        
        if (orderKey) {
          await db.ref(`users/${userId}/orders/${orderKey}/status`).set(status);
          await db.ref(`users/${userId}/orders/${orderKey}/updatedAt`).set(Date.now());
          orderFound = true;
          updatedUserKey = userId;
          updatedOrderKey = orderKey;
        }
      }
    } else {
      // If no userId provided, search through all users
      const usersRef = db.ref('users');
      const usersSnapshot = await usersRef.once('value');

      if (usersSnapshot.exists()) {
        const users = usersSnapshot.val();

        // Search for the order across all users
        for (const [userKey, userData] of Object.entries(users)) {
          if (userData.orders) {
            const orderKey = Object.keys(userData.orders).find(key => 
              userData.orders[key].orderId === orderId
            );
            
            if (orderKey) {
              // Update the order status
              await db.ref(`users/${userKey}/orders/${orderKey}/status`).set(status);
              await db.ref(`users/${userKey}/orders/${orderKey}/updatedAt`).set(Date.now());
              orderFound = true;
              updatedUserKey = userKey;
              updatedOrderKey = orderKey;
              break;
            }
          }
        }
      }
    }

    if (!orderFound) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Get the updated order data to return
    const updatedOrderRef = db.ref(`users/${updatedUserKey}/orders/${updatedOrderKey}`);
    const updatedOrderSnapshot = await updatedOrderRef.once('value');
    const updatedOrderData = updatedOrderSnapshot.val();

    res.status(200).json({
      success: true,
      message: 'Order status updated successfully',
      data: {
        orderId,
        status,
        updatedAt: updatedOrderData.updatedAt,
        order: updatedOrderData
      }
    });

  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
});

// Alternative API endpoint to update order by user and order ID
app.put('/api/users/:userId/orders/:orderKey/status', async (req, res) => {
  try {
    const { userId, orderKey } = req.params;
    const { status } = req.body;

    // Validate required fields
    if (!status) {
      return res.status(400).json({
        success: false,
        message: 'Status is required'
      });
    }

    // Updated valid statuses for 3D printing workflow
    const validStatuses = [
      'pending',
      'processing', 
      'printing',
      'quality_check',
      'packaging',
      'shipped',
      'delivered',
      'cancelled',
      'refunded'
    ];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    // Check if order exists
    const orderRef = db.ref(`users/${userId}/orders/${orderKey}`);
    const orderSnapshot = await orderRef.once('value');

    if (!orderSnapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Update the order status
    await db.ref(`users/${userId}/orders/${orderKey}/status`).set(status);
    await db.ref(`users/${userId}/orders/${orderKey}/updatedAt`).set(Date.now());

    // Get the updated order data
    const updatedOrderSnapshot = await orderRef.once('value');
    const updatedOrderData = updatedOrderSnapshot.val();

    // Optional: Add status history tracking
    const statusHistoryRef = db.ref(`users/${userId}/orders/${orderKey}/statusHistory`);
    const statusHistorySnapshot = await statusHistoryRef.once('value');
    const currentHistory = statusHistorySnapshot.val() || [];
    
    // Add new status to history
    const newStatusEntry = {
      status: status,
      timestamp: Date.now(),
      updatedAt: new Date().toISOString()
    };
    
    currentHistory.push(newStatusEntry);
    await statusHistoryRef.set(currentHistory);

    res.status(200).json({
      success: true,
      message: 'Order status updated successfully',
      data: {
        orderId: updatedOrderData.orderId,
        status,
        updatedAt: updatedOrderData.updatedAt,
        statusHistory: currentHistory,
        order: updatedOrderData
      }
    });

  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
});


//user cart apis
app.post("/api/add-to-cart", async (req, res) => {
  try {
    const { phone, product } = req.body;

    // 🔍 Basic validation
    if (!phone || !product || !product.id) {
      return res.status(400).json({
        success: false,
        message: "Phone number and valid product data are required",
      });
    }

    // 1️⃣ Find user by phone
    const usersSnapshot = await db
      .ref("users")
      .orderByChild("phone")
      .equalTo(phone)
      .once("value");

    const users = usersSnapshot.val();

    if (!users) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const userId = Object.keys(users)[0];

    // 2️⃣ Prepare cart item data
    const cartItem = {
      ...product,
      addedAt: new Date().toISOString(),
      status: "in-cart",
      quantity: product.quantity || 1,
    };

    // 3️⃣ Push to user's cart in Firebase
    const cartRef = db.ref(`users/${userId}/cart`).push();
    await cartRef.set(cartItem);

    res.json({
      success: true,
      message: "Product added to cart successfully!",
      cartItemId: cartRef.key,
      data: cartItem,
    });

  } catch (err) {
    console.error("Error adding to cart:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

app.delete("/api/remove-from-cart", async (req, res) => {
  try {
    const { phone, cartItemId } = req.body; // product key (cart item id) and user phone

    // 🧾 Validation
    if (!phone || !cartItemId) {
      return res.status(400).json({
        success: false,
        message: "Phone number and cartItemId are required",
      });
    }

    // 🔍 Find user by phone
    const usersSnapshot = await db
      .ref("users")
      .orderByChild("phone")
      .equalTo(phone)
      .once("value");

    const users = usersSnapshot.val();

    if (!users) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const userId = Object.keys(users)[0];

    // 🗑️ Reference to user's specific cart item
    const cartItemRef = db.ref(`users/${userId}/cart/${cartItemId}`);

    const snapshot = await cartItemRef.once("value");
    if (!snapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: "Cart item not found",
      });
    }

    // 🔥 Delete the cart item
    await cartItemRef.remove();

    res.json({
      success: true,
      message: "Cart item removed successfully",
    });

  } catch (err) {
    console.error("Error removing cart item:", err);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

//Api to store online store order details
app.post("/api/store-orders", async (req, res) => {
  try {
    const {
      phone,
      address,
      orderTimestamp,
      paymentId,
      orderId,
      status,
      orderType,
      totalPrice,
      subtotal,
      savings,
      deliveryCharge,
      customizationCost,
      items,
      itemCount,
      totalQuantity
    } = req.body;

    // 🔍 Basic validation
    if (!phone || !address || !paymentId || !orderId || !items || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Phone number, address, payment details, and items are required",
      });
    }

    // 1️⃣ Find user by phone number from localStorage
    const usersSnapshot = await db
      .ref("users")
      .orderByChild("phone")
      .equalTo(phone)
      .once("value");

    const users = usersSnapshot.val();

    if (!users) {
      return res.status(404).json({ 
        success: false, 
        message: "User not found with this phone number" 
      });
    }

    const userId = Object.keys(users)[0];

    // 2️⃣ Prepare order data
    const orderData = {
      userId: userId,
      userPhone: phone,
      address: address,
      orderTimestamp: orderTimestamp || new Date().toISOString(),
      paymentId: paymentId,
      orderId: orderId,
      status: status || "paid",
      orderType: orderType || "online-store",
      totalPrice: totalPrice,
      subtotal: subtotal || 0,
      savings: savings || 0,
      deliveryCharge: deliveryCharge || 0,
      customizationCost: customizationCost || 0,
      items: items.map(item => ({
        id: item.id,
        name: item.name,
        description: item.description,
        price: item.price,
        originalPrice: item.originalPrice || item.price,
        quantity: item.quantity,
        image: item.image,
        category: item.category,
        off: item.off || 0,
        totalItemPrice: item.totalItemPrice || (item.price * item.quantity),
        customization: item.customization ? {
          bigText: item.customization.bigText || "",
          mediumText: item.customization.mediumText || "",
          smallText: item.customization.smallText || "",
          specialInstructions: item.customization.specialInstructions || "",
          bigTextChars: item.customization.bigTextChars || 0,
          mediumTextChars: item.customization.mediumTextChars || 0,
          smallTextChars: item.customization.smallTextChars || 0,
          customizationCostPerItem: item.customization.customizationCostPerItem || 0,
          totalCustomizationCost: item.customization.totalCustomizationCost || 0
        } : null,
        addedAt: new Date().toISOString()
      })),
      itemCount: itemCount || items.length,
      totalQuantity: totalQuantity || items.reduce((sum, item) => sum + (item.quantity || 1), 0),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // 3️⃣ Push to user's specific orders collection
    const orderRef = db.ref(`users/${userId}/onlinestoreorders`).push();
    await orderRef.set(orderData);

    // 4️⃣ Also store in global onlinestoreorders collection for admin access
    const globalOrderRef = db.ref("onlinestoreorders").push();
    await globalOrderRef.set({
      ...orderData,
      userOrderId: orderRef.key // Reference to user-specific order
    });

    res.json({
      success: true,
      message: "Order stored successfully!",
      orderId: orderRef.key,
      globalOrderId: globalOrderRef.key,
      data: orderData
    });

  } catch (err) {
    console.error("Error storing order:", err);
    res.status(500).json({ 
      success: false, 
      message: "Internal server error" 
    });
  }
});

//put api to update onlins store order
app.put('/api/users/:userId/onlinestoreorders/:orderKey/status', async (req, res) => {
  try {
    const { userId, orderKey } = req.params;
    const { status } = req.body;

    // Validate required fields
    if (!status) {
      return res.status(400).json({
        success: false,
        message: 'Status is required'
      });
    }

    // Validate status values for online store orders
    const validStatuses = ['paid', 'pending', 'processing', 'packaging', 'shipped', 'delivered', 'cancelled', 'refunded'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    // Check if user exists
    const userRef = db.ref(`users/${userId}`);
    const userSnapshot = await userRef.once('value');

    if (!userSnapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if online store order exists
    const orderRef = db.ref(`users/${userId}/onlinestoreorders/${orderKey}`);
    const orderSnapshot = await orderRef.once('value');

    if (!orderSnapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: 'Online store order not found'
      });
    }

    const orderData = orderSnapshot.val();

    // Update the order status
    await db.ref(`users/${userId}/onlinestoreorders/${orderKey}/status`).set(status);
    await db.ref(`users/${userId}/onlinestoreorders/${orderKey}/updatedAt`).set(new Date().toISOString());

    // Add to status history if needed
    const statusHistory = orderData.statusHistory || [];
    statusHistory.push({
      status: status,
      timestamp: Date.now(),
      updatedAt: new Date().toISOString()
    });
    await db.ref(`users/${userId}/onlinestoreorders/${orderKey}/statusHistory`).set(statusHistory);

    // Get the updated order data
    const updatedOrderSnapshot = await orderRef.once('value');
    const updatedOrderData = updatedOrderSnapshot.val();

    res.status(200).json({
      success: true,
      message: 'Online store order status updated successfully',
      data: {
        orderId: updatedOrderData.orderId,
        status: status,
        updatedAt: updatedOrderData.updatedAt,
        order: updatedOrderData
      }
    });

  } catch (error) {
    console.error('Error updating online store order status:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
});

app.listen(port, () => {
  console.log(`Port started on http://localhost:${port}`);
});