// routes/categories.js - moved out of server.js word for word by scripts/move-area.js
const express = require('express');
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const { prisma } = require('../lib/prisma');

const router = express.Router();

router.get('/api/categories', async (req, res) => {
  try {
    const all = await prisma.category.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, parentId: true },
    });

    const byParent = new Map();
    for (const c of all) {
      if (!byParent.has(c.parentId)) byParent.set(c.parentId, []);
      byParent.get(c.parentId).push(c);
    }

    const build = (parentId) =>
      (byParent.get(parentId) || []).map((c) => ({ id: c.id, name: c.name, children: build(c.id) }));

    res.json({ categories: build(null) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

router.post('/api/admin/categories', requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const parentId = body.parentId ? String(body.parentId) : null;

    if (name.length < 1 || name.length > 60) {
      return res.status(400).json({ error: 'Name must be 1 to 60 characters' });
    }

    if (parentId) {
      const parent = await prisma.category.findUnique({ where: { id: parentId } });
      if (!parent) return res.status(400).json({ error: 'Parent category not found' });
    }

    const duplicate = await prisma.category.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, parentId },
    });
    if (duplicate) {
      return res.status(409).json({ error: 'A category with this name already exists here' });
    }

    const category = await prisma.category.create({ data: { name, parentId } });
    res.status(201).json(category);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

router.put('/api/admin/categories/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const category = await prisma.category.findUnique({ where: { id: req.params.id } });
    if (!category) return res.status(404).json({ error: 'Category not found' });

    const data = {};

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name.length < 1 || name.length > 60) {
        return res.status(400).json({ error: 'Name must be 1 to 60 characters' });
      }
      data.name = name;
    }

    if (body.parentId !== undefined) {
      const newParentId = body.parentId ? String(body.parentId) : null;

      if (newParentId) {
        const all = await prisma.category.findMany({ select: { id: true, parentId: true } });
        if (!all.some((c) => c.id === newParentId)) {
          return res.status(400).json({ error: 'Parent category not found' });
        }

        const blocked = new Set([category.id]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const c of all) {
            if (c.parentId && blocked.has(c.parentId) && !blocked.has(c.id)) {
              blocked.add(c.id);
              grew = true;
            }
          }
        }
        if (blocked.has(newParentId)) {
          return res.status(400).json({ error: 'A category cannot be moved under itself or its own subcategory' });
        }
      }
      data.parentId = newParentId;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const finalName = data.name !== undefined ? data.name : category.name;
    const finalParentId = data.parentId !== undefined ? data.parentId : category.parentId;

    const duplicate = await prisma.category.findFirst({
      where: {
        name: { equals: finalName, mode: 'insensitive' },
        parentId: finalParentId,
        NOT: { id: category.id },
      },
    });
    if (duplicate) {
      return res.status(409).json({ error: 'A category with this name already exists here' });
    }

    const updated = await prisma.category.update({ where: { id: category.id }, data });
    res.json(updated);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

router.delete('/api/admin/categories/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const category = await prisma.category.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { children: true, products: true } } },
    });
    if (!category) return res.status(404).json({ error: 'Category not found' });

    if (category._count.children > 0) {
      return res.status(409).json({ error: 'Move or delete its subcategories first' });
    }
    if (category._count.products > 0) {
      return res.status(409).json({ error: 'Move its products to another category first' });
    }

    await prisma.category.delete({ where: { id: category.id } });
    res.json({ message: 'Category deleted' });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
