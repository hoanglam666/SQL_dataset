CREATE TABLE customers (
  customer_id INT PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  city VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE invoices (
  invoice_id INT PRIMARY KEY,
  customer_id INT NOT NULL,
  total_amount DECIMAL(12,2) NOT NULL,
  issued_date DATE,
  CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);
